import { Router, type Request } from "express";
import { z } from "zod";
import { can } from "@/core/caps";
import { forbidden, notFound, oid, parse } from "@/core/http";
import { requireAuth } from "@/core/security";
import { User } from "@/modules/auth/models";
import { Membership, Org } from "@/modules/orgs/models";
import { Story } from "@/modules/stories/models";
import { presentStories } from "@/modules/stories/routes";
import { notify, notifyMany } from "@/modules/notifications/notifications";
import { Bookmark, Comment, Follow, Reaction, Update } from "./models";

export const updateRoutes = Router();
updateRoutes.use(requireAuth);

// attaches org info and the caller's own reaction state. counts are real counters, never invented.
async function present(items: InstanceType<typeof Update>[], userId: string) {
  const ids = items.map((u) => u._id);
  const [orgs, loved, saved] = await Promise.all([
    Org.find({ _id: { $in: items.map((u) => u.org) } }, "handle name logo"),
    Reaction.find({ user: userId, target: { $in: ids } }, "target"), Bookmark.find({ user: userId, target: { $in: ids } }, "target"),
  ]);
  const set = (l: { target: unknown }[]) => new Set(l.map((x) => String(x.target)));
  const L = set(loved), B = set(saved);
  return items.map((u) => ({ ...u.toObject(), org: orgs.find((o) => String(o._id) === String(u.org)), loved: L.has(String(u._id)), bookmarked: B.has(String(u._id)) }));
}

updateRoutes.get("/feed", async (req, res) => {
  const q = parse(z.object({ tab: z.enum(["for-you", "following"]).default("for-you"), cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(30).default(10), cat: z.string().max(40).optional(), topic: z.string().max(40).optional(), org: z.string().optional() }), req.query);
  const filter: Record<string, unknown> = { hidden: { $ne: true } };
  if (q.cursor) filter._id = { $lt: oid(q.cursor, "cursor") };
  if (q.cat) filter.cat = new RegExp(q.cat.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"); // categories are per organization, so match by words
  if (q.topic) filter.tags = q.topic;
  if (q.org) filter.org = oid(q.org, "organization");
  if (q.tab === "following") {
    const f = await Follow.find({ follower: req.userId, kind: "org" }, "target");
    filter.org = { $in: f.map((x) => x.target) };
  }
  const items = await Update.find(filter).sort({ _id: -1 }).limit(q.limit + 1);
  const page = items.slice(0, q.limit);
  res.json({ items: await present(page, req.userId!), nextCursor: items.length > q.limit ? String(page[page.length - 1]._id) : null });
});
updateRoutes.get("/updates/:id", async (req, res) => {
  const u = await Update.findById(oid(req.params.id, "update")); if (!u || u.hidden) throw notFound("update");
  res.json({ update: (await present([u], req.userId!))[0] });
});

const toggle = (Model: typeof Reaction, counter?: string) => ({
  on: async (req: Request) => {
    const id = oid(req.params.id, "update");
    if (!(await Update.exists({ _id: id }))) throw notFound("update");
    const r = await Model.updateOne({ user: req.userId, target: id }, { $setOnInsert: {} }, { upsert: true });
    if (r.upsertedCount && counter) await Update.updateOne({ _id: id }, { $inc: { [counter]: 1 } }); // idempotent: repeats do not double count
  },
  off: async (req: Request) => {
    const id = oid(req.params.id, "update");
    const r = await Model.deleteOne({ user: req.userId, target: id });
    if (r.deletedCount && counter) await Update.updateOne({ _id: id }, { $inc: { [counter]: -1 } });
  },
});
const love = toggle(Reaction, "counts.loves"), mark = toggle(Bookmark as unknown as typeof Reaction);
updateRoutes.put("/updates/:id/love", async (req, res) => { await love.on(req); res.json({ loved: true }); });
updateRoutes.delete("/updates/:id/love", async (req, res) => { await love.off(req); res.json({ loved: false }); });
updateRoutes.put("/updates/:id/bookmark", async (req, res) => { await mark.on(req); res.json({ bookmarked: true }); });
updateRoutes.delete("/updates/:id/bookmark", async (req, res) => { await mark.off(req); res.json({ bookmarked: false }); });
updateRoutes.get("/bookmarks", async (req, res) => {
  const bs = await Bookmark.find({ user: req.userId }).sort({ createdAt: -1 }).limit(150);
  const [ups, sts] = await Promise.all([Update.find({ _id: { $in: bs.filter((b) => b.kind !== "story").map((b) => b.target) }, hidden: { $ne: true } }), Story.find({ _id: { $in: bs.filter((b) => b.kind === "story").map((b) => b.target) }, hidden: { $ne: true } })]);
  const [shownUps, shownStories] = await Promise.all([present(ups, req.userId!), presentStories(sts, req.userId!)]);
  res.json({ items: bs.map((b) => ({ kind: b.kind, savedAt: b.createdAt, update: shownUps.find((u) => String(u._id) === String(b.target)), story: shownStories.find((s) => String(s._id) === String(b.target)) })).filter((x) => x.update || x.story) });
});

updateRoutes.get("/updates/:id/comments", async (req, res) => {
  const cs = await Comment.find({ update: oid(req.params.id, "update"), hidden: { $ne: true } }).sort({ _id: 1 }).limit(200);
  const users = await User.find({ _id: { $in: cs.map((c) => c.author) } }, "name username avatar");
  const orgs = await Org.find({ _id: { $in: cs.map((c) => c.asOrg).filter(Boolean) } }, "handle name logo");
  res.json({ items: cs.map((c) => ({ ...c.toObject(), author: c.asOrg ? undefined : users.find((u) => String(u._id) === String(c.author)), org: orgs.find((o) => String(o._id) === String(c.asOrg)) })) });
});
updateRoutes.post("/updates/:id/comments", async (req, res) => {
  const b = parse(z.object({ body: z.string().trim().min(1).max(1000), asOrg: z.string().optional(), parent: z.string().optional() }), req.body);
  const u = await Update.findById(oid(req.params.id, "update")); if (!u) throw notFound("update");
  if (b.asOrg) { // commenting as an organization needs the publish capability in that organization
    const m = await Membership.findOne({ org: oid(b.asOrg, "organization"), user: req.userId });
    if (!m || !can(m.role, "publish", m.grants)) throw forbidden("you cannot comment as this organization");
  }
  const c = await Comment.create({ update: u._id, author: req.userId, asOrg: b.asOrg, parent: b.parent ? oid(b.parent, "comment") : undefined, body: b.body });
  await Update.updateOne({ _id: u._id }, { $inc: { "counts.comments": 1 } });
  if (String(u.author) !== req.userId) await notify(u.author, "comments", "someone commented on your update", `/app/update/${u._id}`);
  const names = [...new Set([...b.body.matchAll(/(?:^|\s)@([a-z0-9_]{3,20})\b/gi)].map((m) => m[1].toLowerCase()))].slice(0, 5);
  if (names.length) { const tagged = await User.find({ username: { $in: names }, suspended: { $ne: true }, _id: { $ne: req.userId } }, "_id"); await notifyMany(tagged.map((x) => x._id), "mentions", "someone mentioned you in a comment", `/app/update/${u._id}`); }
  if (b.parent) { const pc = await Comment.findById(oid(b.parent, "comment")); if (pc && String(pc.update) === String(u._id) && String(pc.author) !== req.userId) await notify(pc.author, "replies", "someone replied to your comment", `/app/update/${u._id}`); }
  const staff = await Membership.find({ org: u.org, role: { $in: ["owner", "admin", "delegate"] }, user: { $ne: req.userId } }, "user");
  await notifyMany(staff.map((m) => m.user), "comments", "new comment on one of your organization's updates", `/app/update/${u._id}`, u.org); // shows in the organization alerts
  res.status(201).json({ comment: c });
});
