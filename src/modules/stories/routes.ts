import { Router } from "express";
import { z } from "zod";
import { forbidden, notFound, oid, parse } from "@/core/http";
import { requireAuth } from "@/core/security";
import { User } from "@/modules/auth/models";
import { Org } from "@/modules/orgs/models";
import { notify } from "@/modules/notifications/notifications";
import { Bookmark, Update } from "@/modules/updates/models";
import { mediaUrlOk } from "@/modules/media/routes";
import { Celebration, Story } from "./models";

export const storyRoutes = Router();
storyRoutes.use(requireAuth);

export async function presentStories(items: InstanceType<typeof Story>[], userId: string) {
  const ids = items.map((s) => s._id);
  const [users, ups, cel, saved] = await Promise.all([
    User.find({ _id: { $in: items.map((s) => s.author) } }, "name username avatar"),
    Update.find({ _id: { $in: items.flatMap((s) => s.refs) } }, "title"),
    Celebration.find({ user: userId, target: { $in: ids } }, "target"), Bookmark.find({ user: userId, target: { $in: ids } }, "target"),
  ]);
  const C = new Set(cel.map((x) => String(x.target))), B = new Set(saved.map((x) => String(x.target)));
  return items.map((s) => ({ ...s.toObject(), author: users.find((u) => String(u._id) === String(s.author)), refs: s.refs.map((r) => ({ id: String(r), title: ups.find((u) => String(u._id) === String(r))?.title ?? "removed update" })), celebrated: C.has(String(s._id)), bookmarked: B.has(String(s._id)) }));
}

storyRoutes.get("/", async (req, res) => {
  const q = parse(z.object({ cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(30).default(10), mine: z.enum(["1"]).optional() }), req.query);
  const items = await Story.find({ hidden: { $ne: true }, ...(q.cursor ? { _id: { $lt: oid(q.cursor, "cursor") } } : {}), ...(q.mine ? { author: req.userId } : {}) }).sort({ _id: -1 }).limit(q.limit + 1);
  const page = items.slice(0, q.limit);
  res.json({ items: await presentStories(page, req.userId!), nextCursor: items.length > q.limit ? String(page[page.length - 1]._id) : null });
});
storyRoutes.post("/", async (req, res) => {
  const b = parse(z.object({ title: z.string().trim().max(120).default(""), body: z.string().trim().min(20).max(4000), refs: z.array(z.string()).min(1).max(5), images: z.array(z.string().url().refine(mediaUrlOk, "use images uploaded here")).max(4).default([]) }), req.body);
  const refs = b.refs.map((r) => oid(r, "update"));
  const ups = await Update.find({ _id: { $in: refs } }, "org title");
  if (ups.length !== new Set(refs).size) throw notFound("one of the updates");
  const s = await Story.create({ ...b, refs, author: req.userId });
  for (const orgId of new Set(ups.map((u) => String(u.org)))) { // the organization hears when a story references its update
    const org = await Org.findById(orgId, "owner"); if (org) await notify(org.owner, "testimonials", "a story references one of your updates", "/app/stories", orgId);
  }
  res.status(201).json({ story: (await presentStories([s], req.userId!))[0] });
});
storyRoutes.delete("/:id", async (req, res) => {
  const s = await Story.findById(oid(req.params.id, "story")); if (!s) throw notFound("story");
  if (String(s.author) !== req.userId) throw forbidden();
  await s.deleteOne(); res.json({ ok: true });
});
storyRoutes.put("/:id/celebrate", async (req, res) => {
  const id = oid(req.params.id, "story"); if (!(await Story.exists({ _id: id }))) throw notFound("story");
  const r = await Celebration.updateOne({ user: req.userId, target: id }, { $setOnInsert: {} }, { upsert: true });
  if (r.upsertedCount) await Story.updateOne({ _id: id }, { $inc: { celebrations: 1 } });
  res.json({ celebrated: true });
});
storyRoutes.delete("/:id/celebrate", async (req, res) => {
  const id = oid(req.params.id, "story");
  const r = await Celebration.deleteOne({ user: req.userId, target: id });
  if (r.deletedCount) await Story.updateOne({ _id: id }, { $inc: { celebrations: -1 } });
  res.json({ celebrated: false });
});
storyRoutes.put("/:id/bookmark", async (req, res) => { const id = oid(req.params.id, "story"); await Bookmark.updateOne({ user: req.userId, target: id }, { $setOnInsert: { kind: "story" } }, { upsert: true }); res.json({ bookmarked: true }); });
storyRoutes.delete("/:id/bookmark", async (req, res) => { await Bookmark.deleteOne({ user: req.userId, target: oid(req.params.id, "story") }); res.json({ bookmarked: false }); });
