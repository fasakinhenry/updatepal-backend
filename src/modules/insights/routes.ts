import { Router } from "express";
import { Schema, model, Types } from "mongoose";
import { z } from "zod";
import { can } from "@/core/caps";
import { notFound, oid, parse } from "@/core/http";
import { orgGuard, requireAuth } from "@/core/security";
import { Doc } from "@/modules/documents/routes";
import { Invitation, Membership, Org } from "@/modules/orgs/models";
import { notifyMany } from "@/modules/notifications/notifications";
import { Draft } from "@/modules/publishing/routes";
import { Comment, Follow, Update } from "@/modules/updates/models";

const Feedback = model("Feedback", new Schema({
  org: { type: Schema.Types.ObjectId, required: true, index: true }, author: { type: Schema.Types.ObjectId, required: true },
  category: { type: String, default: "general" }, rating: Number, text: { type: String, required: true },
  status: { type: String, enum: ["new", "reviewed"], default: "new" }, note: { type: String, default: "" },
}, { timestamps: true }));

// followers and visitors send feedback from the organization page
export const feedbackSubmit = Router({ mergeParams: true });
feedbackSubmit.use(requireAuth);
feedbackSubmit.post("/", async (req, res) => {
  const b = parse(z.object({ category: z.enum(["general", "content", "community", "bug"]).default("general"), rating: z.number().int().min(1).max(5).optional(), text: z.string().trim().min(5).max(1500) }), req.body);
  const org = await Org.findOne({ handle: String((req.params as Record<string, string>).handle).toLowerCase() }, "name"); if (!org) throw notFound("organization");
  await Feedback.create({ ...b, org: org._id, author: req.userId });
  const staff = await Membership.find({ org: org._id, role: { $in: ["owner", "admin"] } }, "user");
  await notifyMany(staff.map((m) => m.user), "feedback", "new feedback was submitted", "/app/org/feedback", org._id);
  res.status(201).json({ ok: true });
});

export const insightRoutes = Router({ mergeParams: true });
insightRoutes.use(requireAuth);
const O = (req: { params: unknown }) => (req.params as Record<string, string>).orgId;

insightRoutes.get("/overview", orgGuard(), async (req, res) => {
  const org = O(req), orgId = new Types.ObjectId(oid(org, "organization")), since = new Date(Date.now() - 30 * 86_400_000);
  const staff = can(req.role, "publish", req.grants) || can(req.role, "review", req.grants);
  const orgUpdates = await Update.find({ org: orgId }, "_id");
  const [followers, published, drafts, scheduled, pending, comments, docs] = await Promise.all([
    Follow.countDocuments({ kind: "org", target: org }), Update.countDocuments({ org: orgId, createdAt: { $gte: since } }),
    staff ? Draft.find({ org: orgId, status: { $in: ["draft", "review"] } }, "title status").sort({ updatedAt: -1 }).limit(5) : [],
    staff ? Draft.countDocuments({ org: orgId, status: "scheduled" }) : 0,
    can(req.role, "members", req.grants) ? Invitation.countDocuments({ org: orgId, status: "pending", expiresAt: { $gt: new Date() } }) : 0,
    Comment.find({ update: { $in: orgUpdates.map((u) => u._id) } }, "body update createdAt").sort({ _id: -1 }).limit(4),
    can(req.role, "documents", req.grants) ? Doc.find({ org: orgId, kind: { $ne: "folder" }, vis: { $ne: "private" } }, "name modified updatedAt").sort({ updatedAt: -1 }).limit(4) : [],
  ]);
  res.json({ followers, published30: published, drafts, scheduled, pendingInvites: pending, comments, docs });
});

async function series(orgId: string, days: number) {
  const since = new Date(Date.now() - days * 86_400_000);
  const rows = await Update.aggregate<{ _id: Date; posts: number; loves: number; comments: number }>([
    { $match: { org: new Types.ObjectId(orgId), createdAt: { $gte: since } } },
    { $group: { _id: { $dateTrunc: { date: "$createdAt", unit: "week" } }, posts: { $sum: 1 }, loves: { $sum: "$counts.loves" }, comments: { $sum: "$counts.comments" } } }, { $sort: { _id: 1 } },
  ]);
  const newFollowers = await Follow.countDocuments({ kind: "org", target: orgId, createdAt: { $gte: since } });
  return { series: rows.map((r) => ({ week: r._id.toISOString().slice(0, 10), posts: r.posts, loves: r.loves, comments: r.comments })), followers: { total: await Follow.countDocuments({ kind: "org", target: orgId }), new: newFollowers } };
}
const days = z.coerce.number().int().refine((n) => [7, 30, 90].includes(n)).default(30);
insightRoutes.get("/analytics", orgGuard("analytics"), async (req, res) => { res.json(await series(O(req), parse(days, req.query.days))); });
insightRoutes.get("/analytics.csv", orgGuard("analytics"), async (req, res) => {
  const r = await series(O(req), parse(days, req.query.days));
  res.setHeader("Content-Type", "text/csv"); res.setHeader("Content-Disposition", 'attachment; filename="analytics.csv"');
  res.send("week,posts,loves,comments\n" + r.series.map((s) => `${s.week},${s.posts},${s.loves},${s.comments}`).join("\n"));
});

insightRoutes.get("/calendar", orgGuard(), async (req, res) => {
  if (!can(req.role, "publish", req.grants) && !can(req.role, "review", req.grants)) return void res.json({ items: [] });
  const m = parse(z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/), req.query.month);
  const from = new Date(`${m}-01T00:00:00Z`), to = new Date(from); to.setUTCMonth(to.getUTCMonth() + 1);
  const orgId = new Types.ObjectId(oid(O(req), "organization"));
  const [sched, published] = await Promise.all([Draft.find({ org: orgId, scheduledFor: { $gte: from, $lt: to }, status: { $ne: "published" } }, "title channel status scheduledFor"), Update.find({ org: orgId, createdAt: { $gte: from, $lt: to } }, "title createdAt")]);
  res.json({ items: [...sched.map((d) => ({ id: d._id, kind: d.status === "scheduled" ? "scheduled" : "planned", title: d.title || "untitled", date: d.scheduledFor, channel: d.channel })), ...published.map((u) => ({ id: u._id, kind: "published", title: u.title, date: u.createdAt, channel: "updatebase" }))] });
});

insightRoutes.get("/feedback", orgGuard("analytics"), async (req, res) => { res.json({ items: await Feedback.find({ org: O(req) }).sort({ _id: -1 }).limit(200) }); });
insightRoutes.patch("/feedback/:id", orgGuard("analytics"), async (req, res) => {
  const b = parse(z.object({ status: z.enum(["new", "reviewed"]), note: z.string().max(1000) }).partial().strict(), req.body);
  const f = await Feedback.findOneAndUpdate({ _id: oid(req.params.id, "feedback"), org: O(req) }, b, { new: true }); if (!f) throw notFound("feedback");
  res.json({ feedback: f });
});
