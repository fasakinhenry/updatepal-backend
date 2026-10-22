import { Router } from "express";
import { z } from "zod";
import { conflict, forbidden, notFound, oid, parse } from "@/core/http";
import { requireAuth } from "@/core/security";
import { Bookmark, Comment, Follow, Update } from "@/modules/updates/models";
import { Story } from "@/modules/stories/models";
import { Membership, Org } from "@/modules/orgs/models";
import { purgeUser } from "./purge";
import { mediaUrlOk } from "@/modules/media/routes";
import { publicUser } from "@/modules/auth/routes";
import { User } from "@/modules/auth/models";
import { notify } from "@/modules/notifications/notifications";

export const userRoutes = Router();
userRoutes.use(requireAuth);

const https = z.string().url().max(500).refine((u) => u.startsWith("https://") || mediaUrlOk(u), "use an https image link").refine((u) => !u.startsWith("http://") || mediaUrlOk(u), "use an https image link");
userRoutes.get("/me", async (req, res) => {
  const u = await User.findById(req.userId); if (!u) throw notFound("user");
  res.json({ user: publicUser(u) });
});
userRoutes.patch("/me", async (req, res) => {
  const b = parse(z.object({
    name: z.string().trim().min(2).max(80), username: z.string().trim().toLowerCase().regex(/^[a-z0-9_]{3,20}$/, "3 to 20 letters, numbers or underscores"),
    gender: z.string().max(30).optional(), dob: z.coerce.date().max(new Date()).optional(), avatar: https.optional(), bio: z.string().max(600).optional(),
    interests: z.array(z.string().max(40)).max(20).optional(),
    location: z.object({ city: z.string().max(80).optional(), country: z.string().max(80).optional(), remote: z.boolean().optional(), relocate: z.boolean().optional() }).optional(),
    visibility: z.enum(["public", "followers", "members", "private"]).optional(), prefs: z.object({ updates: z.boolean(), comments: z.boolean(), mentions: z.boolean(), follows: z.boolean() }).partial().optional(), links: z.array(z.string().url().max(200).refine((u) => u.startsWith("https://"), "use https links")).max(4).optional(), payments: z.object({ preferred: z.enum(["bachs", "paypal"]).optional(), paypalEmail: z.union([z.string().email().max(120), z.literal("")]).optional() }).optional(), acceptsDms: z.boolean().optional(), onboarded: z.boolean().optional(),
  }).partial().strict(), req.body);
  if (b.username && (await User.exists({ username: b.username, _id: { $ne: req.userId } }))) throw conflict("username_taken", "that username is taken");
  const u = await User.findByIdAndUpdate(req.userId, b, { new: true }); if (!u) throw notFound("user");
  res.json({ user: publicUser(u) });
});
/** the profile privacy rules, enforced here and not in the client. */
async function canView(u: InstanceType<typeof User>, viewer: string) {
  if (String(u._id) === viewer) return true;
  if (u.suspended || u.visibility === "private") return false;
  if (u.visibility === "followers") return !!(await Follow.exists({ follower: viewer, kind: "user", target: String(u._id) }));
  if (u.visibility === "members") { const mine = await Membership.distinct("org", { user: viewer }); return mine.length > 0 && !!(await Membership.exists({ user: u._id, org: { $in: mine } })); } // people who share an organization
  return true;
}
userRoutes.get("/by-username/:username", async (req, res) => {
  const u = await User.findOne({ username: String(req.params.username).toLowerCase() }); if (!u || (u.suspended && String(u._id) !== req.userId)) throw notFound("profile");
  const follows = !!(await Follow.exists({ follower: req.userId, kind: "user", target: String(u._id) }));
  if (!(await canView(u, req.userId!))) return void res.json({ profile: { username: u.username, name: u.name, avatar: u.avatar, visibility: u.visibility, restricted: true } });
  const [followers, following, stories, updates] = await Promise.all([
    Follow.countDocuments({ kind: "user", target: String(u._id) }), Follow.countDocuments({ follower: u._id }),
    Story.find({ author: u._id, hidden: { $ne: true } }, "title body images createdAt celebrations").sort({ _id: -1 }).limit(20), Update.find({ author: u._id, hidden: { $ne: true } }, "title cat createdAt org").sort({ _id: -1 }).limit(20),
  ]);
  res.json({ profile: { id: String(u._id), username: u.username, name: u.name, avatar: u.avatar, bio: u.bio, interests: u.interests, links: u.links, visibility: u.visibility, acceptsDms: u.acceptsDms, following: follows, restricted: false, followers, followingCount: following, stories, updates } });
});
userRoutes.get("/by-username/:username/connections", async (req, res) => {
  const kind = parse(z.enum(["followers", "following"]), req.query.kind);
  const u = await User.findOne({ username: String(req.params.username).toLowerCase() }); if (!u || !(await canView(u, req.userId!))) throw notFound("profile");
  const rows = await Follow.find(kind === "followers" ? { kind: "user", target: String(u._id) } : { follower: u._id, kind: "user" }).sort({ _id: -1 }).limit(100);
  const ids = kind === "followers" ? rows.map((r) => r.follower) : rows.map((r) => r.target);
  res.json({ items: await User.find({ _id: { $in: ids }, suspended: { $ne: true }, visibility: { $ne: "private" } }, "name username avatar") });
});
userRoutes.get("/me/follows", async (req, res) => { res.json({ items: await Follow.find({ follower: req.userId }, "kind target") }); });
userRoutes.get("/me/export", async (req, res) => {
  const [user, stories, comments, bookmarks, follows] = await Promise.all([User.findById(req.userId, "-passwordHash"), Story.find({ author: req.userId }), Comment.find({ author: req.userId }), Bookmark.find({ user: req.userId }), Follow.find({ follower: req.userId })]);
  res.setHeader("Content-Disposition", 'attachment; filename="updatebase-export.json"'); res.json({ exportedAt: new Date(), user, stories, comments, bookmarks, follows });
});
userRoutes.delete("/me", async (req, res) => {
  const { confirm } = parse(z.object({ confirm: z.literal("delete") }), req.body);
  void confirm;
  if (await Membership.exists({ user: req.userId, role: "owner" })) throw forbidden("transfer or delete the organizations you own first");
  await purgeUser(req.userId!); res.json({ ok: true });
});

const target = z.object({ kind: z.enum(["org", "user"]), target: z.string().min(1).max(40) });
userRoutes.put("/follows", async (req, res) => {
  const b = parse(target, req.body);
  if (b.kind === "user" && b.target === req.userId) throw conflict("self_follow", "you cannot follow yourself");
  if (b.kind === "org" && !(await Org.exists({ _id: oid(b.target, "organization") }))) throw notFound("organization");
  const r = await Follow.updateOne({ follower: req.userId, ...b }, { $setOnInsert: {} }, { upsert: true });
  if (r.upsertedCount && b.kind === "user") await notify(b.target, "social", "you have a new follower", "/app/profile");
  if (r.upsertedCount && b.kind === "org") { const o = await Org.findById(b.target, "owner name"); if (o) await notify(o.owner, "followers", `someone followed ${o.name}`, "/app/org", o._id); }
  res.json({ following: true });
});
userRoutes.delete("/follows", async (req, res) => {
  const b = parse(target, req.body);
  await Follow.deleteOne({ follower: req.userId, ...b });
  res.json({ following: false });
});
