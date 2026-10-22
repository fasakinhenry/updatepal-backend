import { Router } from "express";
import rateLimit from "express-rate-limit";
import { Schema, model, type Types } from "mongoose";
import { z } from "zod";
import { can } from "@/core/caps";
import { ApiError, forbidden, notFound, oid, parse } from "@/core/http";
import { orgGuard, requireAuth } from "@/core/security";
import { Membership, Org } from "@/modules/orgs/models";
import { Follow, Update } from "@/modules/updates/models";
import { notify, notifyMany } from "@/modules/notifications/notifications";
import { mediaUrlOk } from "@/modules/media/routes";
import { formatWithAi } from "./ai-formatter";
import { channelMax, formatDeterministic, type Rules } from "./formatter";

const statuses = ["draft", "review", "approved", "scheduled", "published"] as const;
const metaSchema = z.object({ images: z.array(z.string().url().refine(mediaUrlOk, "use images uploaded here")).max(4).default([]), title: z.string().trim().min(2).max(160), cat: z.string().max(60).default("community update"), tags: z.array(z.string().max(30)).max(10).default([]), deadline: z.string().max(60).optional(), place: z.string().max(80).optional(), link: z.string().url().max(500).optional() });
type Meta = z.infer<typeof metaSchema>;

export const Draft = model("Draft", new Schema({
  org: { type: Schema.Types.ObjectId, required: true, index: true }, owner: { type: Schema.Types.ObjectId, required: true },
  title: { type: String, default: "" }, source: { type: String, default: "" }, body: { type: String, default: "" },
  channel: { type: String, default: "whatsapp" }, status: { type: String, enum: statuses, default: "draft" },
  scheduledFor: Date, meta: Schema.Types.Mixed, updateId: Schema.Types.ObjectId,
}, { timestamps: true }));

/**
 * publishes a draft. the claim is atomic, so a double click or the scheduler racing a person cannot publish twice.
 * the update number comes from a counter incremented in the database, so concurrent delegates never collide.
 */
export async function publishDraft(orgId: string | Types.ObjectId, draftId: string, authorId: Types.ObjectId | string, meta: Meta, fromStatus?: "scheduled") {
  const org = await Org.findById(orgId); if (!org) throw notFound("organization");
  if (org.suspended) throw new ApiError(403, "org_suspended", "this organization is suspended");
  const need = org.rules?.requireReview && !fromStatus ? { status: "approved" } : { status: fromStatus ?? { $ne: "published" } };
  const d = await Draft.findOneAndUpdate({ _id: draftId, org: org._id, ...need }, { status: "published" });
  if (!d) throw new ApiError(409, "cannot_publish", org.rules?.requireReview ? "this draft must be approved first" : "this draft is missing or already published");
  if (!d.body.trim()) { await Draft.updateOne({ _id: d._id }, { status: "draft" }); throw new ApiError(400, "empty_draft", "the draft has no content"); }
  let number: number | undefined;
  if (org.rules?.numbering) number = (await Org.findByIdAndUpdate(org._id, { $inc: { nextNumber: 1 } }))!.nextNumber;
  const u = await Update.create({ org: org._id, author: authorId, ...meta, tags: meta.tags.map((t) => t.toLowerCase()), body: d.body, number });
  await Draft.updateOne({ _id: d._id }, { updateId: u._id });
  const followers = await Follow.find({ kind: "org", target: String(org._id) }, "follower").limit(1000); // followers hear about new updates
  await notifyMany(followers.map((f) => f.follower), "updates", `${org.name} posted: ${meta.title}`, `/app/update/${u._id}`);
  return u;
}

/** runs while the server is awake. for guaranteed timing move this to a cron or worker host. */
export function startScheduler() {
  setInterval(async () => {
    const due = await Draft.find({ status: "scheduled", scheduledFor: { $lte: new Date() } }).limit(20).catch(() => []);
    for (const d of due) {
      const meta = metaSchema.safeParse(d.meta);
      if (!meta.success) { await Draft.updateOne({ _id: d._id }, { status: "draft" }); await notify(d.owner, "publishing", "a scheduled post was missing details and moved back to drafts", "/app/org/publish", d.org); continue; }
      try { await publishDraft(d.org, String(d._id), d.owner, meta.data, "scheduled"); }
      catch (e) { console.error("scheduled publish failed", e); await Draft.updateOne({ _id: d._id }, { status: "draft" }); await notify(d.owner, "publishing", "a scheduled post failed to publish and moved back to drafts", "/app/org/publish", d.org); }
    }
  }, 60_000);
}

export const publishingRoutes = Router({ mergeParams: true });
publishingRoutes.use(requireAuth);
const channel = z.enum(Object.keys(channelMax) as [string, ...string[]]);
const aiLimit = rateLimit({ windowMs: 3_600_000, limit: 60, keyGenerator: (req) => String(req.userId), standardHeaders: true, legacyHeaders: false, validate: false });

const chOk = (req: { role?: string; channels?: string[] }, ch: string) => !req.channels?.length || req.role === "owner" || req.role === "admin" || req.channels.includes(ch); // members can be limited to the channels they are assigned
publishingRoutes.post("/format", orgGuard("publish"), aiLimit, async (req, res) => {
  const b = parse(z.object({ source: z.string().max(20000), channel: channel.default("whatsapp"), hint: z.string().max(300).default("") }), req.body);
  if (!chOk(req, b.channel)) throw forbidden("you are not assigned to this channel");
  const org = await Org.findById(oid(req.params.orgId)); if (!org) throw notFound("organization");
  const rules = (org.rules ?? {}) as Rules;
  const number = rules.numbering ? org.nextNumber : null;
  // only the organization's own published updates are used as style examples, never drafts or documents
  const examples = rules.useExamples === false ? [] : (await Update.find({ org: org._id }).sort({ _id: -1 }).limit(3)).map((u) => u.body);
  const r = (await formatWithAi(b.source, rules, b.channel, number, b.hint, examples)) ?? formatDeterministic(b.source, rules, b.channel, number, b.hint);
  res.json({ ...r, numberIsPreview: true });
});

publishingRoutes.get("/drafts", orgGuard(), async (req, res) => {
  if (!can(req.role, "publish", req.grants) && !can(req.role, "review", req.grants)) throw forbidden();
  res.json({ items: await Draft.find({ org: req.params.orgId }).sort({ updatedAt: -1 }).limit(100) });
});
publishingRoutes.post("/drafts", orgGuard("publish"), async (req, res) => {
  const b = parse(z.object({ title: z.string().max(120).default(""), source: z.string().max(20000).default(""), body: z.string().max(20000).default(""), channel: channel.default("whatsapp") }), req.body);
  if (!chOk(req, b.channel)) throw forbidden("you are not assigned to this channel");
  res.status(201).json({ draft: await Draft.create({ ...b, org: req.params.orgId, owner: req.userId }) });
});
publishingRoutes.patch("/drafts/:id", orgGuard(), async (req, res) => {
  const b = parse(z.object({ title: z.string().max(120), source: z.string().max(20000), body: z.string().max(20000), channel, status: z.enum(statuses), scheduledFor: z.coerce.date().nullable(), meta: metaSchema }).partial().strict(), req.body);
  const d = await Draft.findOne({ _id: oid(req.params.id, "draft"), org: req.params.orgId }); if (!d) throw notFound("draft");
  const org = await Org.findById(req.params.orgId, "rules");
  if (d.status === "published") throw new ApiError(409, "already_published", "published drafts cannot be changed");
  if (b.status === "published") throw new ApiError(400, "use_publish", "use the publish endpoint");
  if (b.status === "approved" && !can(req.role, "review", req.grants)) throw forbidden("only reviewers can approve");
  if (b.status && b.status !== "approved" && !can(req.role, "publish", req.grants) && !can(req.role, "review", req.grants)) throw forbidden();
  if ((b.title !== undefined || b.body !== undefined || b.source !== undefined || b.channel || b.scheduledFor !== undefined || b.meta) && !can(req.role, "publish", req.grants)) throw forbidden();
  if (b.status === "scheduled") {
    const when = b.scheduledFor ?? d.scheduledFor; const meta = b.meta ?? d.meta;
    if (!when || when.getTime() < Date.now() + 30_000) throw new ApiError(400, "bad_schedule", "pick a time in the future");
    if (!metaSchema.safeParse(meta).success) throw new ApiError(400, "missing_details", "add a title and category before scheduling");
    if (org?.rules?.requireReview && d.status !== "approved" && d.status !== "scheduled") throw new ApiError(409, "needs_approval", "this draft must be approved before it can be scheduled");
  }
  Object.assign(d, b);
  await d.save();
  if (b.status === "review") { // tell reviewers there is something waiting
    const reviewers = await Membership.find({ org: d.org, role: { $in: ["owner", "admin", "reviewer"] }, user: { $ne: req.userId } }, "user");
    await notifyMany(reviewers.map((m) => m.user), "reviews", "a draft is waiting for review", "/app/org/publish", d.org);
  }
  res.json({ draft: d });
});
publishingRoutes.delete("/drafts/:id", orgGuard("publish"), async (req, res) => {
  await Draft.deleteOne({ _id: oid(req.params.id, "draft"), org: req.params.orgId, status: { $ne: "published" } });
  res.json({ ok: true });
});
publishingRoutes.post("/drafts/:id/publish", orgGuard("publish"), async (req, res) => {
  const meta = parse(metaSchema, req.body);
  res.status(201).json({ update: await publishDraft(oid(req.params.orgId), oid(req.params.id, "draft"), req.userId!, meta) });
});
