import { Router } from "express";
import { Schema, model, type Types } from "mongoose";
import { z } from "zod";
import { parse } from "@/core/http";
import { push } from "@/core/realtime";
import { User } from "@/modules/auth/models";
import { requireAuth } from "@/core/security";

const Notification = model("Notification", new Schema({
  user: { type: Schema.Types.ObjectId, index: true, required: true },
  type: String, text: String, link: String, org: { type: Schema.Types.ObjectId, index: true }, read: { type: Boolean, default: false },
}, { timestamps: true }));

// which personal setting controls which notification type
const prefKey: Record<string, string> = { updates: "updates", comments: "comments", replies: "comments", mentions: "mentions", social: "follows", followers: "follows" };
async function allowed(users: (Types.ObjectId | string)[], type: string) {
  const k = prefKey[type]; if (!k) return users;
  const off = new Set((await User.find({ _id: { $in: users }, [`prefs.${k}`]: false }, "_id")).map((u) => String(u._id)));
  return users.filter((u) => !off.has(String(u)));
}
/** one place that creates notifications so the same event is never duplicated across modules. */
export async function notify(user: Types.ObjectId | string, type: string, text: string, link: string, org?: Types.ObjectId | string) {
  await notifyMany([user], type, text, link, org);
}
export async function notifyMany(users: (Types.ObjectId | string)[], type: string, text: string, link: string, org?: Types.ObjectId | string) {
  const to = await allowed(users, type); if (!to.length) return;
  await Notification.insertMany(to.map((user) => ({ user, type, text, link, org })));
  to.forEach((u) => push(u, "notification", { type })); // live ping for open tabs
}

export const notificationRoutes = Router();
notificationRoutes.use(requireAuth);
notificationRoutes.get("/", async (req, res) => {
  const items = await Notification.find({ user: req.userId, ...(req.query.unread === "1" ? { read: false } : {}), ...(typeof req.query.org === "string" ? { org: req.query.org } : { org: null }) }).sort({ _id: -1 }).limit(50);
  res.json({ items, unread: await Notification.countDocuments({ user: req.userId, read: false }) });
});
notificationRoutes.post("/read", async (req, res) => {
  const b = parse(z.object({ ids: z.array(z.string()).max(100).optional() }), req.body);
  await Notification.updateMany({ user: req.userId, ...(b.ids ? { _id: { $in: b.ids } } : {}) }, { read: true });
  res.json({ ok: true });
});
