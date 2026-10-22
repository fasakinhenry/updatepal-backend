import { Router } from "express";
import { Schema, model } from "mongoose";
import { z } from "zod";
import { ApiError, forbidden, notFound, oid, parse } from "@/core/http";
import { push } from "@/core/realtime";
import { requireAuth } from "@/core/security";
import { User } from "@/modules/auth/models";

// end to end encryption. clients encrypt and decrypt with web crypto (ecdh p-256, hkdf, aes-256-gcm).
// the server stores only public keys, a passcode encrypted backup of the private key, and ciphertext.
// it cannot read messages. it still sees who talks to whom and when.
export const Conversation = model("Conversation", new Schema({
  members: { type: [Schema.Types.ObjectId], index: true }, key: { type: String, unique: true }, lastAt: Date,
  reads: [{ user: Schema.Types.ObjectId, at: Date }],
}, { timestamps: true }));
export const Message = model("Message", new Schema({
  conversation: { type: Schema.Types.ObjectId, index: true, required: true }, sender: { type: Schema.Types.ObjectId, required: true },
  ct: { type: String, required: true }, iv: { type: String, required: true },
  spk: String, rpk: String, // the public keys used, so history stays readable after a key reset
}, { timestamps: true }));
export const Block = model("Block", (() => { const s = new Schema({ blocker: { type: Schema.Types.ObjectId, required: true }, blocked: { type: Schema.Types.ObjectId, required: true } }, { timestamps: true }); s.index({ blocker: 1, blocked: 1 }, { unique: true }); return s; })());
export const Report = model("Report", new Schema({ reporter: Schema.Types.ObjectId, kind: String, target: String, reason: String, status: { type: String, default: "open" }, resolution: String, note: String }, { timestamps: true }));

export const messageRoutes = Router();
messageRoutes.use(requireAuth);
const b64 = (max: number) => z.string().min(4).max(max).regex(/^[A-Za-z0-9+/=_-]+$/);
const blocked = async (a: string, b: string) => !!(await Block.exists({ $or: [{ blocker: a, blocked: b }, { blocker: b, blocked: a }] }));
async function mine(id: unknown, userId: string) {
  const c = await Conversation.findOne({ _id: oid(id, "conversation"), members: userId }); if (!c) throw notFound("conversation");
  return c;
}

messageRoutes.get("/keys/me", async (req, res) => { const u = await User.findById(req.userId, "e2ee"); res.json({ keys: u?.e2ee?.publicKey ? u.e2ee : null }); });
messageRoutes.put("/keys/me", async (req, res) => {
  const b = parse(z.object({ publicKey: b64(200), wrapped: b64(2000), salt: b64(100), iv: b64(60), iterations: z.number().int().min(100_000).max(2_000_000), replace: z.boolean().optional() }), req.body);
  const u = await User.findById(req.userId, "e2ee"); if (!u) throw notFound("user");
  // replacing keys makes older messages unreadable, so it must be explicit
  if (u.e2ee?.publicKey && !b.replace) throw new ApiError(409, "keys_exist", "encrypted messaging is already set up");
  const { replace, ...keys } = b; void replace;
  await User.updateOne({ _id: req.userId }, { e2ee: keys }); res.json({ ok: true });
});
messageRoutes.get("/keys/:userId/public", async (req, res) => {
  const u = await User.findById(oid(req.params.userId, "person"), "e2ee"); if (!u?.e2ee?.publicKey) throw new ApiError(404, "no_keys", "this person has not set up encrypted messaging yet");
  res.json({ publicKey: u.e2ee.publicKey });
});

messageRoutes.get("/conversations", async (req, res) => {
  const cs = await Conversation.find({ members: req.userId, lastAt: { $ne: null } }).sort({ lastAt: -1 }).limit(100);
  const others = cs.map((c) => c.members.find((m) => String(m) !== req.userId)!);
  const users = await User.find({ _id: { $in: others } }, "name username avatar");
  res.json({ items: cs.map((c, i) => { const r = c.reads.find((x) => String(x.user) === req.userId)?.at; return { id: c._id, user: users.find((u) => String(u._id) === String(others[i])), lastAt: c.lastAt, unread: !!c.lastAt && (!r || r < c.lastAt) }; }) });
});
messageRoutes.post("/conversations", async (req, res) => {
  const { username } = parse(z.object({ username: z.string().trim().toLowerCase().min(3).max(20) }), req.body);
  const other = await User.findOne({ username }); if (!other) throw notFound("person");
  const me = req.userId!;
  if (String(other._id) === me) throw new ApiError(400, "self_message", "you cannot message yourself");
  if (!other.acceptsDms) throw new ApiError(403, "dms_disabled", "this person is not accepting direct messages");
  if (await blocked(me, String(other._id))) throw forbidden("you cannot message this person");
  if (!(await User.exists({ _id: me, "e2ee.publicKey": { $exists: true } }))) throw new ApiError(409, "no_keys", "set up encrypted messaging first");
  if (!other.e2ee?.publicKey) throw new ApiError(409, "peer_no_keys", "this person has not set up encrypted messaging yet");
  const key = [me, String(other._id)].sort().join(":");
  const c = (await Conversation.findOne({ key })) ?? (await Conversation.create({ key, members: [me, other._id] }));
  res.json({ id: c._id, peerId: String(other._id), peerKey: other.e2ee.publicKey });
});
messageRoutes.get("/conversations/:id/messages", async (req, res) => {
  const c = await mine(req.params.id, req.userId!);
  const items = await Message.find({ conversation: c._id }).sort({ _id: -1 }).limit(100);
  res.json({ items: items.reverse() });
});
messageRoutes.post("/conversations/:id/messages", async (req, res) => {
  const b = parse(z.object({ ct: b64(9000), iv: b64(40), spk: b64(200), rpk: b64(200) }), req.body);
  const c = await mine(req.params.id, req.userId!);
  const otherId = String(c.members.find((m) => String(m) !== req.userId));
  if (await blocked(req.userId!, otherId)) throw forbidden("you cannot message this person");
  const [me, peer] = await Promise.all([User.findById(req.userId, "e2ee"), User.findById(otherId, "e2ee acceptsDms")]);
  if (!peer?.acceptsDms) throw new ApiError(403, "dms_disabled", "this person is not accepting direct messages");
  if (me?.e2ee?.publicKey !== b.spk || peer.e2ee?.publicKey !== b.rpk) throw new ApiError(409, "stale_key", "encryption keys changed. reload the conversation and try again");
  const m = await Message.create({ conversation: c._id, sender: req.userId, ...b });
  c.lastAt = new Date(); c.set("reads", [...c.reads.filter((r) => String(r.user) !== req.userId), { user: req.userId, at: c.lastAt }]); await c.save();
  push(otherId, "message", { conversation: String(c._id) }); // live ping, the content stays encrypted
  res.status(201).json({ message: m });
});
messageRoutes.post("/conversations/:id/read", async (req, res) => {
  const c = await mine(req.params.id, req.userId!);
  c.set("reads", [...c.reads.filter((r) => String(r.user) !== req.userId), { user: req.userId, at: new Date() }]); await c.save();
  res.json({ ok: true });
});

messageRoutes.get("/blocks", async (req, res) => {
  const bs = await Block.find({ blocker: req.userId }); const users = await User.find({ _id: { $in: bs.map((x) => x.blocked) } }, "name username avatar");
  res.json({ items: users });
});
messageRoutes.put("/blocks/:userId", async (req, res) => {
  const id = oid(req.params.userId, "person"); if (id === req.userId) throw new ApiError(400, "self_block", "you cannot block yourself");
  await Block.updateOne({ blocker: req.userId, blocked: id }, { $setOnInsert: {} }, { upsert: true }); res.json({ blocked: true });
});
messageRoutes.delete("/blocks/:userId", async (req, res) => { await Block.deleteOne({ blocker: req.userId, blocked: oid(req.params.userId, "person") }); res.json({ blocked: false }); });
messageRoutes.post("/reports", async (req, res) => {
  const b = parse(z.object({ kind: z.enum(["user", "update", "story", "message", "org", "comment"]), target: z.string().max(40), reason: z.string().trim().min(3).max(1000) }), req.body);
  await Report.create({ ...b, reporter: req.userId }); res.status(201).json({ ok: true });
});
