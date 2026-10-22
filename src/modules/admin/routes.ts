import { Router, type Request } from "express";
import rateLimit from "express-rate-limit";
import mongoose, { Types } from "mongoose";
import { z } from "zod";
import { aiStatus } from "@/core/ai";
import { encryptionReady } from "@/core/crypto";
import { env, isAdminEmail } from "@/core/env";
import { ApiError, conflict, forbidden, notFound, oid, parse } from "@/core/http";
import { forgetUser, requireAdmin, requireAuth } from "@/core/security";
import { defaults, setSetting, settings, type Settings } from "@/core/settings";
import { Session, User } from "@/modules/auth/models";
import { Doc } from "@/modules/documents/routes";
import { Conversation, Message, Report } from "@/modules/messages/routes";
import { notify } from "@/modules/notifications/notifications";
import { Membership, Org } from "@/modules/orgs/models";
import { purgeOrg } from "@/modules/orgs/purge";
import { decryptField } from "@/core/crypto";
import { markWithdrawalPaid, rejectWithdrawal } from "@/modules/payments/ledger";
import { Ledger, Tip, Wallet, Withdrawal } from "@/modules/payments/models";
import { hasPayments, payoutsEnabled, providers } from "@/modules/payments/provider";
import { Draft } from "@/modules/publishing/routes";
import { Story } from "@/modules/stories/models";
import { AiLog, AuditLog } from "@/modules/system/models";
import { Bookmark, Comment, Follow, Update } from "@/modules/updates/models";
import { purgeUser } from "@/modules/users/purge";

export const adminRoutes = Router();
adminRoutes.use(requireAuth, requireAdmin, rateLimit({ windowMs: 60_000, limit: 240, keyGenerator: (r) => String(r.userId), standardHeaders: true, legacyHeaders: false, validate: false }));

const audit = async (req: Request, action: string, target: string, detail?: unknown) => { const a = await User.findById(req.userId, "email"); await AuditLog.create({ actor: req.userId, actorEmail: a?.email, action, target, detail, ip: req.ip }); };
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const since = (days: number) => new Date(Date.now() - days * 86_400_000);
const daily = async (M: mongoose.Model<any>, days: number, match: Record<string, unknown> = {}, field = "createdAt") => { // eslint-disable-line @typescript-eslint/no-explicit-any
  const r = await M.aggregate<{ _id: Date; n: number }>([{ $match: { [field]: { $gte: since(days) }, ...match } }, { $group: { _id: { $dateTrunc: { date: `$${field}`, unit: "day" } }, n: { $sum: 1 } } }, { $sort: { _id: 1 } }]);
  return r.map((x) => ({ day: x._id.toISOString().slice(0, 10), n: x.n }));
};
const top = async (M: mongoose.Model<any>, field: string, limit = 8, unwind = false) => (await M.aggregate<{ _id: string; n: number }>([{ $match: { [field]: { $nin: [null, ""] } } }, ...(unwind ? [{ $unwind: `$${field}` }] : []), { $group: { _id: `$${field}`, n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: limit }])).map((x) => ({ key: x._id, n: x.n })); // eslint-disable-line @typescript-eslint/no-explicit-any

adminRoutes.get("/overview", async (req, res) => {
  const days = parse(z.coerce.number().int().refine((n) => [7, 30, 90].includes(n)).default(30), req.query.days);
  const d1 = since(1), d7 = since(7), d30 = since(30);
  const [users, verified, onboarded, suspended, orgs, updates, stories, comments, convos, messages, reports, drafts, scheduled, follows, bookmarks, dau, wau, mau, returning, withOrg, storage, tipsPaid, pendingWd, platform] = await Promise.all([
    User.countDocuments(), User.countDocuments({ emailVerified: true }), User.countDocuments({ onboarded: true }), User.countDocuments({ suspended: true }), Org.countDocuments(),
    Update.countDocuments(), Story.countDocuments(), Comment.countDocuments(), Conversation.countDocuments(), Message.countDocuments(), Report.countDocuments({ status: "open" }), Draft.countDocuments(), Draft.countDocuments({ status: "scheduled" }),
    Follow.countDocuments(), Bookmark.countDocuments(), User.countDocuments({ lastSeenAt: { $gte: d1 } }), User.countDocuments({ lastSeenAt: { $gte: d7 } }), User.countDocuments({ lastSeenAt: { $gte: d30 } }),
    User.countDocuments({ lastSeenAt: { $gte: d7 }, createdAt: { $lt: d30 } }), Membership.distinct("user").then((x) => x.length),
    Doc.aggregate<{ t: number }>([{ $group: { _id: null, t: { $sum: "$size" } } }]).then((x) => x[0]?.t ?? 0),
    Tip.aggregate<{ _id: string; t: number }>([{ $match: { status: "paid" } }, { $group: { _id: "$currency", t: { $sum: "$amount" } } }]),
    Withdrawal.countDocuments({ status: "requested" }), Wallet.find({ kind: "platform" }).then((ws) => ws.map((w) => ({ currency: w.currency, balance: w.balance }))),
  ]);
  const counts = await Follow.aggregate<{ _id: string; n: number }>([{ $match: { kind: "org" } }, { $group: { _id: "$target", n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 8 }]);
  const names = await Org.find({ _id: { $in: counts.map((c) => c._id) } }, "name handle");
  const topUpdates = await Update.find({ hidden: { $ne: true } }, "title counts").sort({ "counts.loves": -1 }).limit(5);
  const [signups, upSeries, stSeries, cmSeries, interests, countries] = await Promise.all([daily(User, days), daily(Update, days), daily(Story, days), daily(Comment, days), top(User, "interests", 10, true), top(User, "location.country", 8)]);
  res.json({
    totals: { users, verified, onboarded, suspended, orgs, updates, stories, comments, conversations: convos, messages, follows, bookmarks, drafts, scheduled, openReports: reports, storageBytes: storage },
    active: { dau, wau, mau, returning }, funnel: { registered: users, verified, onboarded, inAnOrg: withOrg },
    money: { tips: tipsPaid.map((t) => ({ currency: t._id, minor: t.t })), fees: platform, pendingWithdrawals: pendingWd },
    series: { signups, updates: upSeries, stories: stSeries, comments: cmSeries }, interests, countries,
    topOrgs: counts.map((c) => ({ id: c._id, followers: c.n, name: names.find((o) => String(o._id) === c._id)?.name ?? "deleted" })), topUpdates: topUpdates.map((u) => ({ id: u._id, title: u.title, loves: u.counts?.loves ?? 0, comments: u.counts?.comments ?? 0 })),
    authMix: { google: await User.countDocuments({ googleId: { $exists: true } }), password: await User.countDocuments({ passwordHash: { $exists: true } }) },
  });
});

const userView = (u: InstanceType<typeof User>) => ({ id: u._id, email: u.email, name: u.name, username: u.username, avatar: u.avatar, verified: u.emailVerified, onboarded: u.onboarded, suspended: !!u.suspended, suspendedReason: u.suspendedReason, createdAt: u.createdAt, lastSeenAt: u.lastSeenAt, hasGoogle: !!u.googleId, visibility: u.visibility, country: u.location?.country, hasKeys: !!u.e2ee?.publicKey, isAdmin: isAdminEmail(u.email) });
adminRoutes.get("/users", async (req, res) => {
  const q = parse(z.object({ q: z.string().max(80).optional(), filter: z.enum(["all", "unverified", "suspended", "not_onboarded", "inactive"]).default("all"), cursor: z.string().optional() }), req.query);
  const f: Record<string, unknown> = {};
  if (q.q) { const re = new RegExp(esc(q.q), "i"); f.$or = [{ email: re }, { name: re }, { username: re }]; }
  if (q.filter === "unverified") f.emailVerified = false; if (q.filter === "suspended") f.suspended = true; if (q.filter === "not_onboarded") f.onboarded = false; if (q.filter === "inactive") f.$and = [{ $or: [{ lastSeenAt: { $lt: since(30) } }, { lastSeenAt: null }] }];
  if (q.cursor) f._id = { $lt: oid(q.cursor, "cursor") };
  const items = await User.find(f).sort({ _id: -1 }).limit(26);
  res.json({ items: items.slice(0, 25).map(userView), nextCursor: items.length > 25 ? String(items[24]._id) : null, total: await User.countDocuments() });
});
adminRoutes.get("/users/:id", async (req, res) => {
  const u = await User.findById(oid(req.params.id, "user")); if (!u) throw notFound("user");
  const [ms, stories, comments, following, followers, sessions, tips] = await Promise.all([Membership.find({ user: u._id }), Story.countDocuments({ author: u._id }), Comment.countDocuments({ author: u._id }), Follow.countDocuments({ follower: u._id }), Follow.countDocuments({ kind: "user", target: String(u._id) }), Session.countDocuments({ user: u._id }), Tip.countDocuments({ tipper: u._id, status: "paid" })]);
  const orgs = await Org.find({ _id: { $in: ms.map((m) => m.org) } }, "name handle");
  res.json({ user: userView(u), orgs: ms.map((m) => ({ role: m.role, org: orgs.find((o) => String(o._id) === String(m.org)) })), counts: { stories, comments, following, followers, sessions, tipsPaid: tips } });
});
adminRoutes.post("/users/:id/action", async (req, res) => {
  const b = parse(z.object({ action: z.enum(["suspend", "unsuspend", "logout", "verify", "delete"]), reason: z.string().max(300).optional(), confirm: z.string().optional() }), req.body);
  const id = oid(req.params.id, "user"); const u = await User.findById(id); if (!u) throw notFound("user");
  if (isAdminEmail(u.email) && b.action !== "logout") throw forbidden("admin accounts cannot be changed here");
  if (b.action === "suspend") { u.suspended = true; u.suspendedReason = b.reason ?? ""; await u.save(); await Session.deleteMany({ user: id }); forgetUser(id); }
  if (b.action === "unsuspend") { u.suspended = false; u.suspendedReason = undefined; await u.save(); forgetUser(id); }
  if (b.action === "logout") { await Session.deleteMany({ user: id }); forgetUser(id); }
  if (b.action === "verify") { u.emailVerified = true; await u.save(); }
  if (b.action === "delete") {
    if (b.confirm !== u.email) throw new ApiError(400, "confirmation_mismatch", "type the user's email to confirm");
    if (await Membership.exists({ user: id, role: "owner" })) throw conflict("owns_orgs", "this user owns organizations. transfer or delete them first");
    await purgeUser(id);
  }
  await audit(req, `user.${b.action}`, u.email, { reason: b.reason });
  res.json({ ok: true });
});
adminRoutes.get("/users.csv", async (req, res) => {
  const us = await User.find({}, "email name username emailVerified onboarded suspended createdAt lastSeenAt").sort({ _id: 1 }).limit(50_000);
  await audit(req, "export.users", "csv", { rows: us.length });
  const q = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  res.setHeader("Content-Type", "text/csv"); res.setHeader("Content-Disposition", 'attachment; filename="users.csv"');
  res.send("id,email,name,username,verified,onboarded,suspended,created,last_seen\n" + us.map((u) => [u._id, u.email, u.name, u.username, u.emailVerified, u.onboarded, u.suspended, u.createdAt?.toISOString(), u.lastSeenAt?.toISOString()].map(q).join(",")).join("\n"));
});

adminRoutes.get("/orgs", async (req, res) => {
  const q = parse(z.object({ q: z.string().max(80).optional(), cursor: z.string().optional() }), req.query);
  const f: Record<string, unknown> = {};
  if (q.q) { const re = new RegExp(esc(q.q), "i"); f.$or = [{ name: re }, { handle: re }]; }
  if (q.cursor) f._id = { $lt: oid(q.cursor, "cursor") };
  const items = await Org.find(f, "name handle category suspended owner createdAt nextNumber").sort({ _id: -1 }).limit(26);
  const page = items.slice(0, 25); const ids = page.map((o) => o._id);
  const [mem, ups, fol] = await Promise.all([Membership.aggregate<{ _id: Types.ObjectId; n: number }>([{ $match: { org: { $in: ids } } }, { $group: { _id: "$org", n: { $sum: 1 } } }]), Update.aggregate<{ _id: Types.ObjectId; n: number }>([{ $match: { org: { $in: ids } } }, { $group: { _id: "$org", n: { $sum: 1 } } }]), Follow.aggregate<{ _id: string; n: number }>([{ $match: { kind: "org", target: { $in: ids.map(String) } } }, { $group: { _id: "$target", n: { $sum: 1 } } }])]);
  const n = (a: { _id: unknown; n: number }[], id: unknown) => a.find((x) => String(x._id) === String(id))?.n ?? 0;
  const owners = await User.find({ _id: { $in: page.map((o) => o.owner) } }, "email");
  res.json({ items: page.map((o) => ({ id: o._id, name: o.name, handle: o.handle, category: o.category, suspended: !!o.suspended, createdAt: o.createdAt, owner: owners.find((u) => String(u._id) === String(o.owner))?.email, members: n(mem, o._id), updates: n(ups, o._id), followers: n(fol, o._id) })), nextCursor: items.length > 25 ? String(page[24]._id) : null });
});
adminRoutes.post("/orgs/:id/action", async (req, res) => {
  const b = parse(z.object({ action: z.enum(["suspend", "unsuspend", "delete"]), reason: z.string().max(300).optional(), confirm: z.string().optional() }), req.body);
  const org = await Org.findById(oid(req.params.id, "organization")); if (!org) throw notFound("organization");
  if (b.action === "suspend") { org.suspended = true; await org.save(); await Update.updateMany({ org: org._id, hidden: { $ne: true } }, { hidden: true, hiddenReason: "org_suspended" }); }
  if (b.action === "unsuspend") { org.suspended = false; await org.save(); await Update.updateMany({ org: org._id, hiddenReason: "org_suspended" }, { hidden: false, $unset: { hiddenReason: 1 } }); }
  if (b.action === "delete") { if (b.confirm !== org.handle) throw new ApiError(400, "confirmation_mismatch", "type the organization handle to confirm"); await purgeOrg(org); }
  if (b.action !== "delete") await notify(org.owner, "orgs", b.action === "suspend" ? `${org.name} was suspended${b.reason ? `: ${b.reason}` : ""}` : `${org.name} is active again`, "/app/org", org._id);
  await audit(req, `org.${b.action}`, org.handle, { reason: b.reason });
  res.json({ ok: true });
});

const kinds = { updates: Update, stories: Story, comments: Comment } as const;
adminRoutes.get("/content", async (req, res) => {
  const q = parse(z.object({ kind: z.enum(["updates", "stories", "comments"]).default("updates"), q: z.string().max(80).optional(), hidden: z.enum(["1"]).optional() }), req.query);
  const re = q.q ? new RegExp(esc(q.q), "i") : null;
  const f: Record<string, unknown> = { ...(q.hidden ? { hidden: true } : {}) };
  if (re) f.$or = q.kind === "comments" ? [{ body: re }] : [{ title: re }, { body: re }];
  const items = await (kinds[q.kind] as mongoose.Model<any>).find(f).sort({ _id: -1 }).limit(50); // eslint-disable-line @typescript-eslint/no-explicit-any
  res.json({ items: items.map((x) => ({ id: x._id, title: x.title ?? "", body: String(x.body ?? "").slice(0, 200), hidden: !!x.hidden, createdAt: x.createdAt })) });
});
adminRoutes.post("/content/:kind/:id/hidden", async (req, res) => {
  const kind = parse(z.enum(["updates", "stories", "comments"]), req.params.kind); const { hidden } = parse(z.object({ hidden: z.boolean() }), req.body);
  await (kinds[kind] as mongoose.Model<any>).updateOne({ _id: oid(req.params.id, "item") }, hidden ? { hidden, hiddenReason: "moderation" } : { hidden, $unset: { hiddenReason: 1 } }); // eslint-disable-line @typescript-eslint/no-explicit-any
  await audit(req, hidden ? "content.hide" : "content.unhide", `${kind}:${req.params.id}`); res.json({ ok: true });
});

adminRoutes.get("/reports", async (req, res) => {
  const status = parse(z.enum(["open", "resolved", "all"]).default("open"), req.query.status);
  const rs = await Report.find(status === "all" ? {} : { status }).sort({ _id: -1 }).limit(100);
  const reporters = await User.find({ _id: { $in: rs.map((r) => r.reporter) } }, "email username");
  const preview = async (kind?: string | null, target?: string | null) => {
    if (!kind || !target || !Types.ObjectId.isValid(target)) return "";
    if (kind === "update") return (await Update.findById(target, "title"))?.title ?? "removed";
    if (kind === "story") { const s = await Story.findById(target, "title body"); return s ? s.title || s.body.slice(0, 80) : "removed"; }
    if (kind === "comment") return (await Comment.findById(target, "body"))?.body.slice(0, 80) ?? "removed";
    if (kind === "user") { const u = await User.findById(target, "email username"); return u ? `${u.username ?? ""} ${u.email}` : "removed"; }
    if (kind === "org") return (await Org.findById(target, "name"))?.name ?? "removed";
    return "";
  };
  res.json({ items: await Promise.all(rs.map(async (r) => ({ id: r._id, kind: r.kind, target: r.target, reason: r.reason, status: r.status, resolution: r.resolution, note: r.note, createdAt: r.createdAt, reporter: reporters.find((u) => String(u._id) === String(r.reporter))?.email, preview: await preview(r.kind, r.target) }))) });
});
adminRoutes.post("/reports/:id/resolve", async (req, res) => {
  const b = parse(z.object({ action: z.enum(["dismiss", "hide", "suspend_user"]), note: z.string().max(500).optional() }), req.body);
  const r = await Report.findById(oid(req.params.id, "report")); if (!r) throw notFound("report");
  const t = r.target ?? "";
  if (b.action === "hide" && Types.ObjectId.isValid(t)) {
    const M = ({ update: Update, story: Story, comment: Comment } as Record<string, mongoose.Model<any>>)[r.kind ?? ""]; // eslint-disable-line @typescript-eslint/no-explicit-any
    if (M) await M.updateOne({ _id: t }, { hidden: true, hiddenReason: "moderation" });
  }
  if (b.action === "suspend_user") {
    let uid: string | undefined = r.kind === "user" ? t : undefined;
    if (r.kind === "story") uid = String((await Story.findById(t, "author"))?.author ?? ""); if (r.kind === "comment") uid = String((await Comment.findById(t, "author"))?.author ?? ""); if (r.kind === "update") uid = String((await Update.findById(t, "author"))?.author ?? "");
    const u = uid && Types.ObjectId.isValid(uid) ? await User.findById(uid) : null;
    if (u && !isAdminEmail(u.email)) { u.suspended = true; u.suspendedReason = "report: " + (b.note ?? ""); await u.save(); await Session.deleteMany({ user: u._id }); forgetUser(String(u._id)); }
  }
  r.status = "resolved"; r.resolution = b.action; r.note = b.note; await r.save();
  await audit(req, `report.${b.action}`, `${r.kind}:${t}`, { note: b.note }); res.json({ ok: true });
});

adminRoutes.get("/ai", async (_req, res) => {
  const s = since(30);
  const [total, failed, avg, byKind, byDay, byProvider] = await Promise.all([
    AiLog.countDocuments({ createdAt: { $gte: s } }), AiLog.countDocuments({ createdAt: { $gte: s }, ok: false }), AiLog.aggregate<{ a: number }>([{ $match: { createdAt: { $gte: s } } }, { $group: { _id: null, a: { $avg: "$ms" } } }]).then((x) => Math.round(x[0]?.a ?? 0)),
    AiLog.aggregate<{ _id: string; n: number; bad: number }>([{ $match: { createdAt: { $gte: s } } }, { $group: { _id: "$kind", n: { $sum: 1 }, bad: { $sum: { $cond: ["$ok", 0, 1] } } } }]),
    daily(AiLog, 30), AiLog.aggregate<{ _id: string; n: number }>([{ $match: { createdAt: { $gte: s } } }, { $group: { _id: { $concat: ["$provider", ":", "$model"] }, n: { $sum: 1 } } }]),
  ]);
  res.json({ status: aiStatus(), enabled: (await settings()).aiEnabled, last30d: { total, failed, avgMs: avg }, byKind: byKind.map((k) => ({ kind: k._id, n: k.n, failed: k.bad })), byDay, byProvider: byProvider.map((p) => ({ key: p._id, n: p.n })), note: "provider and model are set with environment variables. no prompt or response content is stored." });
});

adminRoutes.get("/system", async (_req, res) => {
  const storage = await Doc.aggregate<{ t: number; n: number }>([{ $group: { _id: null, t: { $sum: "$size" }, n: { $sum: 1 } } }]);
  res.json({ uptimeSeconds: Math.round(process.uptime()), runtime: typeof Bun !== "undefined" ? `bun ${Bun.version}` : `node ${process.version}`, db: ["disconnected", "connected", "connecting", "disconnecting"][mongoose.connection.readyState], mode: env.NODE_ENV,
    due: await Draft.countDocuments({ status: "scheduled", scheduledFor: { $lte: new Date() } }), scheduledTotal: await Draft.countDocuments({ status: "scheduled" }),
    integrations: { ai: aiStatus(), email: !!env.RESEND_API_KEY, google: !!env.GOOGLE_CLIENT_ID, payments: { providers: Object.keys(providers), configured: hasPayments, paypalPayouts: payoutsEnabled }, withdrawalEncryption: encryptionReady, adminEmails: env.ADMIN_EMAIL ? 1 : 0 },
    storage: { files: storage[0]?.n ?? 0, bytes: storage[0]?.t ?? 0, driver: "local disk" }, clientOrigin: env.CLIENT_ORIGIN });
});
adminRoutes.get("/settings", async (_req, res) => { res.json({ settings: await settings() }); });
adminRoutes.put("/settings", async (req, res) => {
  const b = parse(z.object({ key: z.enum(Object.keys(defaults) as [keyof Settings, ...(keyof Settings)[]]), value: z.union([z.boolean(), z.string().max(300), z.number().int().min(0).max(100_000_000)]) }), req.body);
  if (typeof b.value !== typeof defaults[b.key]) throw new ApiError(400, "validation_error", "wrong value type for this setting");
  if (b.key === "platformFeeBps" && (b.value as number) > 5000) throw new ApiError(400, "validation_error", "the fee cannot exceed 50%");
  await setSetting(b.key, b.value as never); await audit(req, "settings.update", b.key, { value: b.value }); res.json({ settings: await settings() });
});
adminRoutes.get("/audit", async (_req, res) => { res.json({ items: await AuditLog.find().sort({ _id: -1 }).limit(200) }); });

adminRoutes.get("/payments", async (_req, res) => {
  const [tips, wds, paid, wallets] = await Promise.all([Tip.find().sort({ _id: -1 }).limit(50), Withdrawal.find({}, "-bank.numberEnc -paypal.enc").sort({ status: 1, _id: -1 }).limit(100), Tip.aggregate<{ _id: { s: string; p: string; c: string }; n: number; t: number }>([{ $group: { _id: { s: "$status", p: "$provider", c: "$currency" }, n: { $sum: 1 }, t: { $sum: "$amount" } } }]), Wallet.find().sort({ balance: -1 }).limit(100)]);
  // reconciliation: a wallet balance must equal the sum of its ledger rows
  const sums = await Ledger.aggregate<{ _id: { k: string; o: string; c: string }; t: number }>([{ $group: { _id: { k: "$kind", o: "$owner", c: "$currency" }, t: { $sum: "$amount" } } }]);
  const bad = wallets.filter((w) => (sums.find((s) => s._id.k === w.kind && s._id.o === w.owner && s._id.c === w.currency)?.t ?? 0) !== w.balance).map((w) => ({ kind: w.kind, owner: w.owner, currency: w.currency, balance: w.balance }));
  res.json({ providers: Object.keys(providers), configured: hasPayments, paypalPayouts: payoutsEnabled, byStatus: paid.map((p) => ({ status: p._id.s, provider: p._id.p, currency: p._id.c, n: p.n, minor: p.t })), tips, withdrawals: wds, mismatches: bad });
});
adminRoutes.post("/withdrawals/:id/reveal", async (req, res) => {
  const w = await Withdrawal.findById(oid(req.params.id, "withdrawal")); if (!w) throw notFound("withdrawal");
  await audit(req, "withdrawal.reveal_destination", String(w._id));
  res.json(w.method === "paypal" ? { method: "paypal", paypalEmail: w.paypal?.enc ? decryptField(w.paypal.enc) : "" } : { method: "bank", accountNumber: w.bank?.numberEnc ? decryptField(w.bank.numberEnc) : "", bankCode: w.bank?.bankCode, bankName: w.bank?.bankName, accountName: w.bank?.accountName });
});
// pays a paypal withdrawal through the paypal payouts api. the batch id becomes the payout reference.
adminRoutes.post("/withdrawals/:id/paypal-payout", async (req, res) => {
  const p = providers.paypal; if (!payoutsEnabled || !p?.payout) throw new ApiError(501, "payouts_disabled", "paypal payouts are not enabled. set PAYPAL_PAYOUTS=true");
  const w = await Withdrawal.findOne({ _id: oid(req.params.id, "withdrawal"), status: "requested", method: "paypal" }); if (!w?.paypal?.enc) throw conflict("not_payable", "this withdrawal cannot be paid with paypal");
  const r = await p.payout({ id: `wd_${w._id}`, email: decryptField(w.paypal.enc), amount: ((w.amount ?? 0) / 100).toFixed(2), currency: w.currency!, note: "updatebase wallet withdrawal" });
  await markWithdrawalPaid(String(w._id), req.userId!, `paypal:${r.ref}`); await audit(req, "withdrawal.paypal_payout", String(w._id), { batch: r.ref }); res.json({ ok: true, reference: r.ref });
});
adminRoutes.post("/withdrawals/:id/decide", async (req, res) => {
  const b = parse(z.object({ decision: z.enum(["paid", "rejected"]), reference: z.string().max(120).optional(), note: z.string().max(300).optional() }), req.body);
  const id = oid(req.params.id, "withdrawal");
  if (b.decision === "paid" && !b.reference) throw new ApiError(400, "validation_error", "enter the payout reference from your provider dashboard");
  const w = b.decision === "paid" ? await markWithdrawalPaid(id, req.userId!, b.reference!) : await rejectWithdrawal(id, req.userId!, b.note ?? "");
  if (!w) throw conflict("already_decided", "this withdrawal was already decided");
  await audit(req, `withdrawal.${b.decision}`, id, { reference: b.reference, note: b.note }); res.json({ ok: true });
});
