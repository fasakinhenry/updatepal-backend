import { Router } from "express";
import { z } from "zod";
import { roles } from "@/core/caps";
import { env } from "@/core/env";
import { ApiError, conflict, forbidden, notFound, oid, parse } from "@/core/http";
import { sendMail } from "@/core/mailer";
import { orgGuard, randomToken, requireAuth, sha256 } from "@/core/security";
import { User } from "@/modules/auth/models";
import { notify } from "@/modules/notifications/notifications";
import { Follow } from "@/modules/updates/models";
import { purgeOrg } from "./purge";
import { mediaUrlOk } from "@/modules/media/routes";
import { Invitation, Membership, Org } from "./models";

export const orgRoutes = Router();
export const invitationRoutes = Router();
const https = z.string().url().max(500).refine((u) => u.startsWith("https://") || mediaUrlOk(u), "use an https link");
export const rulesSchema = z.object({
  lowercase: z.boolean(), numbering: z.boolean(), prefix: z.string().max(10), footer: z.string().max(200), link: z.union([https, z.literal("")]),
  attribution: z.boolean(), handle: z.string().max(40), instructions: z.string().max(2000), requireReview: z.boolean(), tone: z.string().max(200), categories: z.array(z.string().trim().min(2).max(40)).max(12), maxLength: z.number().int().min(100).max(5000), useExamples: z.boolean(),
}).partial();
const grantable = z.enum(roles).refine((r) => r !== "owner", "ownership is transferred separately");

// public profile, safe fields only
orgRoutes.get("/by-handle/:handle", async (req, res) => {
  const o = await Org.findOne({ handle: String(req.params.handle).toLowerCase(), suspended: { $ne: true } }, "handle name category description bio logo banner feedbackPublic");
  if (!o) throw notFound("organization");
  res.json({ org: o, followers: await Follow.countDocuments({ kind: "org", target: String(o._id) }) });
});

orgRoutes.use(requireAuth);
orgRoutes.post("/", async (req, res) => {
  const b = parse(z.object({
    name: z.string().trim().min(2).max(80), handle: z.string().trim().toLowerCase().regex(/^[a-z0-9_-]{3,24}$/), category: z.string().max(40).default("community"),
    description: z.string().max(280).default(""), bio: z.string().max(1000).default(""), logo: https.optional(), rules: rulesSchema.optional(),
  }), req.body);
  if (await Org.exists({ handle: b.handle })) throw conflict("handle_taken", "that handle is taken");
  const org = await Org.create({ ...b, owner: req.userId, nextNumber: 1 });
  try { await Membership.create({ org: org._id, user: req.userId, role: "owner" }); } catch (e) { await org.deleteOne(); throw e; }
  res.status(201).json({ org });
});
orgRoutes.get("/mine", async (req, res) => {
  const ms = await Membership.find({ user: req.userId });
  const orgs = await Org.find({ _id: { $in: ms.map((m) => m.org) } }, "handle name logo");
  res.json({ items: ms.map((m) => ({ role: m.role, grants: m.grants, channels: m.channels, org: orgs.find((o) => String(o._id) === String(m.org)) })).filter((x) => x.org) });
});
orgRoutes.get("/:orgId", orgGuard(), async (req, res) => {
  const o = await Org.findById(oid(req.params.orgId)); if (!o) throw notFound("organization");
  res.json({ org: o, role: req.role });
});
orgRoutes.patch("/:orgId", orgGuard("settings"), async (req, res) => {
  const b = parse(z.object({ name: z.string().trim().min(2).max(80), description: z.string().max(280), bio: z.string().max(1000), logo: https, banner: https, rules: rulesSchema, tipMode: z.enum(["attribution", "shared", "org"]), tipOrgPercent: z.number().int().min(0).max(100), feedbackPublic: z.boolean(), paypalEmail: z.union([z.string().email().max(120), z.literal("")]) }).partial().strict(), req.body);
  const { rules, ...rest } = b;
  const set: Record<string, unknown> = { ...rest };
  for (const [k, v] of Object.entries(rules ?? {})) set[`rules.${k}`] = v; // merge, never overwrite the whole rules object
  const o = await Org.findByIdAndUpdate(oid(req.params.orgId), { $set: set }, { new: true });
  res.json({ org: o });
});

orgRoutes.get("/:orgId/members", orgGuard(), async (req, res) => {
  const ms = await Membership.find({ org: oid(req.params.orgId) });
  const users = await User.find({ _id: { $in: ms.map((m) => m.user) } }, "name username avatar");
  res.json({ items: ms.map((m) => ({ userId: String(m.user), role: m.role, grants: m.grants, channels: m.channels, joined: m.createdAt, user: users.find((u) => String(u._id) === String(m.user)) })) });
});
orgRoutes.patch("/:orgId/members/:userId", orgGuard("members"), async (req, res) => {
  const b = parse(z.object({ role: grantable.optional(), grants: z.array(z.enum(["publish", "review", "documents", "members", "analytics"])).max(5).optional(), channels: z.array(z.enum(["updatebase", "whatsapp", "facebook", "instagram", "linkedin", "x"])).max(6).optional() }), req.body);
  const m = await Membership.findOne({ org: req.params.orgId, user: oid(req.params.userId, "member") }); if (!m) throw notFound("member");
  if (m.role === "owner") throw forbidden("the owner's role cannot be changed here");
  if (b.role) m.role = b.role; if (b.grants) m.set("grants", b.grants); if (b.channels) m.set("channels", b.channels); await m.save(); res.json({ ok: true });
});
orgRoutes.delete("/:orgId/members/:userId", orgGuard(), async (req, res) => {
  const uid = oid(req.params.userId, "member");
  const m = await Membership.findOne({ org: req.params.orgId, user: uid }); if (!m) throw notFound("member");
  if (m.role === "owner") throw forbidden("the owner cannot be removed");
  if (uid !== req.userId && !(req.role === "owner" || req.role === "admin")) throw forbidden(); // leaving is always allowed
  await m.deleteOne(); res.json({ ok: true });
});

orgRoutes.get("/:orgId/invitations", orgGuard("members"), async (req, res) => {
  await Invitation.updateMany({ org: req.params.orgId, status: "pending", expiresAt: { $lt: new Date() } }, { status: "expired" });
  res.json({ items: await Invitation.find({ org: req.params.orgId }, "-tokenHash").sort({ _id: -1 }).limit(100) });
});
orgRoutes.post("/:orgId/invitations", orgGuard("members"), async (req, res) => {
  const b = parse(z.object({ via: z.enum(["email", "username", "link"]), email: z.string().trim().toLowerCase().email().optional(), username: z.string().trim().toLowerCase().optional(), role: grantable.default("member"), days: z.number().int().min(1).max(30).default(7) }), req.body);
  if (b.via === "email" && !b.email) throw new ApiError(400, "validation_error", "email is required");
  if (b.via === "username" && !b.username) throw new ApiError(400, "validation_error", "username is required");
  const org = await Org.findById(oid(req.params.orgId)); if (!org) throw notFound("organization");
  const token = randomToken();
  const inv = await Invitation.create({ org: org._id, role: b.role, via: b.via, email: b.email, username: b.username, tokenHash: sha256(token), invitedBy: req.userId, expiresAt: new Date(Date.now() + b.days * 86_400_000) });
  const link = `${env.CLIENT_ORIGIN}/invite?token=${token}`;
  if (b.via === "email") await sendMail(b.email!, `you are invited to ${org.name} on updatebase`, `join ${org.name}: ${link}\n\nthis link expires in ${b.days} days.`);
  if (b.via === "username") { const u = await User.findOne({ username: b.username }); if (u) await notify(u._id, "orgs", `${org.name} invited you to join`, "/app/notifications"); }
  // the raw token is returned once so the owner can share a link. it is never stored.
  res.status(201).json({ invitation: { id: inv._id, status: inv.status, via: inv.via, role: inv.role, expiresAt: inv.expiresAt }, ...(b.via === "link" ? { link } : {}) });
});
orgRoutes.delete("/:orgId/invitations/:id", orgGuard("members"), async (req, res) => {
  await Invitation.updateOne({ _id: oid(req.params.id, "invitation"), org: req.params.orgId, status: "pending" }, { status: "revoked" });
  res.json({ ok: true });
});

// accepting needs a signed in user. visiting the link alone never grants membership.
invitationRoutes.use(requireAuth);
async function load(token: string, userId: string) {
  const inv = await Invitation.findOne({ tokenHash: sha256(token), status: "pending" });
  if (!inv) throw new ApiError(400, "invalid_invitation", "this invitation is invalid or no longer active");
  if (inv.expiresAt < new Date()) { inv.status = "expired"; await inv.save(); throw new ApiError(400, "invitation_expired", "this invitation has expired"); }
  const u = await User.findById(userId); if (!u) throw notFound("user");
  if (inv.via === "email" && !(u.emailVerified && u.email === inv.email)) throw forbidden("this invitation was sent to a different, verified email");
  if (inv.via === "username" && u.username !== inv.username) throw forbidden("this invitation was sent to a different username");
  return inv;
}
const tok = z.object({ token: z.string().min(10).max(100) });
invitationRoutes.post("/accept", async (req, res) => {
  const inv = await load(parse(tok, req.body).token, req.userId!);
  await Membership.updateOne({ org: inv.org, user: req.userId }, { $setOnInsert: { role: inv.role } }, { upsert: true });
  inv.status = "accepted"; await inv.save();
  const org = await Org.findById(inv.org, "owner name"); if (org) await notify(org.owner, "orgs", "an invitation was accepted", "/app/org/members");
  res.json({ ok: true, orgId: inv.org });
});
invitationRoutes.post("/decline", async (req, res) => {
  const inv = await load(parse(tok, req.body).token, req.userId!);
  inv.status = "declined"; await inv.save(); res.json({ ok: true });
});

// ownership transfer and deletion are owner only and always need an explicit confirmation
orgRoutes.post("/:orgId/transfer", orgGuard("settings"), async (req, res) => {
  if (req.role !== "owner") throw forbidden("only the owner can transfer ownership");
  const b = parse(z.object({ userId: z.string(), confirm: z.string() }), req.body);
  const org = await Org.findById(oid(req.params.orgId)); if (!org) throw notFound("organization");
  if (b.confirm !== org.handle) throw new ApiError(400, "confirmation_mismatch", "type the organization handle to confirm");
  const target = await Membership.findOne({ org: org._id, user: oid(b.userId, "member") }); if (!target) throw notFound("member");
  await Membership.updateOne({ org: org._id, user: req.userId }, { role: "admin" });
  target.role = "owner"; await target.save(); org.owner = target.user; await org.save();
  res.json({ ok: true });
});
orgRoutes.delete("/:orgId", orgGuard("settings"), async (req, res) => {
  if (req.role !== "owner") throw forbidden("only the owner can delete the organization");
  const org = await Org.findById(oid(req.params.orgId)); if (!org) throw notFound("organization");
  if (parse(z.object({ confirm: z.string() }), req.body).confirm !== org.handle) throw new ApiError(400, "confirmation_mismatch", "type the organization handle to confirm");
  await purgeOrg(org); res.json({ ok: true });
});
