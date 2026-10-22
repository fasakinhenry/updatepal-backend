import { randomBytes } from "node:crypto";
import express, { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { can } from "@/core/caps";
import { encryptField, encryptionReady } from "@/core/crypto";
import { env } from "@/core/env";
import { ApiError, forbidden, notFound, oid, parse } from "@/core/http";
import { requireAuth } from "@/core/security";
import { settings } from "@/core/settings";
import { User } from "@/modules/auth/models";
import { Membership, Org } from "@/modules/orgs/models";
import { Update } from "@/modules/updates/models";
import { balances, computeSplit, creditTip } from "./ledger";
import { Ledger, Tip, Wallet, WebhookEvent, Withdrawal } from "./models";
import { candidates, planTips } from "./plan";
import { providers, type PaymentProvider, type ProviderEvent, type ProviderName } from "./provider";

export const paymentRoutes = Router();
const major = (minor: number) => (minor / 100).toFixed(2);

/** credits a tip only if the paid amount and currency match what we recorded. returns true when credited now. */
async function settleTip(tip: InstanceType<typeof Tip>, amount: string, currency: string) {
  if (Math.round(Number(amount) * 100) !== tip.amount || currency !== tip.currency) { tip.status = "mismatch"; await tip.save(); console.error("tip amount mismatch", String(tip._id)); return false; }
  const t = await Tip.findOneAndUpdate({ _id: tip._id, status: { $in: ["pending", "expired"] } }, { status: "paid", paidAt: new Date() }, { new: true });
  if (!t) return false; // already settled
  await creditTip(t); return true;
}

// provider webhooks. verified by the provider's signature, deduplicated by event id, and checked against our own record.
async function webhook(p: PaymentProvider | undefined, req: express.Request, res: express.Response, handle: (ev: ProviderEvent) => Promise<void>) {
  if (!p) throw new ApiError(501, "payments_not_configured", "this payment provider is not configured");
  const ev = Buffer.isBuffer(req.body) ? await p.verifyWebhook(req.body, req.headers) : null;
  if (!ev?.id) throw new ApiError(400, "invalid_signature", "invalid webhook");
  try { await WebhookEvent.create({ _id: `${p.name}:${ev.id}`, type: ev.type }); } catch (e) { if ((e as { code?: number }).code === 11000) return void res.json({ ok: true, duplicate: true }); throw e; }
  try { await handle(ev); } catch (e) { await WebhookEvent.deleteOne({ _id: `${p.name}:${ev.id}` }); throw e; } // let the provider retry
  res.json({ ok: true });
}
const raw = express.raw({ type: () => true, limit: "200kb" });
paymentRoutes.post("/webhook", raw, (req, res) => webhook(providers.bachs, req, res, async (ev) => {
  const d = ev.data as { checkout_id?: string; amount?: string; currency?: string };
  if (ev.type === "collection.succeeded" && d.checkout_id) { const tip = await Tip.findOne({ checkoutId: d.checkout_id, provider: "bachs" }); if (tip) await settleTip(tip, String(d.amount), String(d.currency)); else console.warn("webhook for an unknown checkout", d.checkout_id); }
  else if (ev.type === "checkout.expired" && d.checkout_id) await Tip.updateOne({ checkoutId: d.checkout_id, status: "pending" }, { status: "expired" });
}));
paymentRoutes.post("/paypal/webhook", raw, (req, res) => webhook(providers.paypal, req, res, async (ev) => {
  const d = ev.data as { custom_id?: string; amount?: { value?: string; currency_code?: string } };
  if (ev.type === "PAYMENT.CAPTURE.COMPLETED" && d.custom_id) { const tip = await Tip.findOne({ reference: d.custom_id, provider: "paypal" }); if (tip) await settleTip(tip, String(d.amount?.value), String(d.amount?.currency_code)); }
}));

paymentRoutes.use(requireAuth);
const pick = (name: string): PaymentProvider => { const p = providers[name as ProviderName]; if (!p) throw new ApiError(400, "provider_unavailable", "that payment method is not available"); return p; };
const minTip = (p: PaymentProvider, s: Awaited<ReturnType<typeof settings>>) => (p.name === "paypal" ? s.minTipPaypalMinor : s.minTipKobo);
async function split(updateId: string, amount: number) {
  const u = await Update.findById(oid(updateId, "update")); if (!u || u.hidden) throw notFound("update");
  const org = await Org.findById(u.org); if (!org || org.suspended) throw notFound("organization");
  const s = await settings(); const sp = computeSplit(amount, s.platformFeeBps, org.tipMode ?? "shared", org.tipOrgPercent ?? 70, !!u.author);
  return { u, orgDoc: org, s, fee: sp.fee, orgShare: sp.org, poster: sp.poster };
}
const amountSchema = z.number().positive().max(1_000_000).transform((n) => Math.round(n * 100));

paymentRoutes.get("/tips/quote", async (req, res) => {
  const q = parse(z.object({ update: z.string(), amount: z.coerce.number().positive().max(1_000_000), provider: z.string() }), req.query);
  const p = pick(q.provider); const x = await split(q.update, Math.round(q.amount * 100));
  res.json({ currency: p.currency, amount: Math.round(q.amount * 100), fee: x.fee, orgShare: x.orgShare, posterShare: x.poster, feeBps: x.s.platformFeeBps });
});

async function startCheckout(req: express.Request, p: PaymentProvider, items: { update: string; amount: number }[]) {
  const me = await User.findById(req.userId, "email"); if (!me) throw notFound("user");
  const s = await settings(); if (!s.tippingEnabled) throw new ApiError(403, "tipping_disabled", "tipping is turned off right now");
  if (items.length > 1 && !p.batch) throw new ApiError(400, "batch_unsupported", "this payment method supports one tip at a time");
  const batch = randomBytes(8).toString("hex"), tips: InstanceType<typeof Tip>[] = [];
  for (const it of items) {
    const x = await split(it.update, it.amount);
    if (it.amount < minTip(p, s)) throw new ApiError(400, "amount_too_small", `the minimum tip is ${major(minTip(p, s))} ${p.currency}`);
    tips.push(await Tip.create({ tipper: req.userId, update: x.u._id, org: x.orgDoc._id, poster: x.u.author, provider: p.name, batch, amount: it.amount, currency: p.currency, split: { org: x.orgShare, poster: x.poster, fee: x.fee }, reference: `tip_${randomBytes(12).toString("hex")}`, title: x.u.title }));
  }
  try {
    const c = await p.createCheckout({ reference: `batch_${batch}`, currency: p.currency, email: me.email, units: tips.map((t) => ({ reference: t.reference!, amount: major(t.amount), description: `tip on updatebase` })), metadata: { batch }, successUrl: `${env.CLIENT_ORIGIN}/app/wallet?provider=${p.name}&tip=done`, cancelUrl: `${env.CLIENT_ORIGIN}/app/wallet?provider=${p.name}&cancelled=1` });
    await Tip.updateMany({ batch }, { checkoutId: c.id }); return c.url;
  } catch (e) { await Tip.updateMany({ batch }, { status: "failed" }); throw e; }
}
paymentRoutes.post("/tips", async (req, res) => {
  const b = parse(z.object({ update: z.string(), amount: amountSchema, provider: z.string() }), req.body);
  res.status(201).json({ checkoutUrl: await startCheckout(req, pick(b.provider), [{ update: b.update, amount: b.amount }]) });
});
paymentRoutes.post("/tips/batch", async (req, res) => {
  const b = parse(z.object({ provider: z.string(), items: z.array(z.object({ update: z.string(), amount: amountSchema })).min(1).max(8) }), req.body);
  if (new Set(b.items.map((i) => i.update)).size !== b.items.length) throw new ApiError(400, "validation_error", "each update can appear once");
  res.status(201).json({ checkoutUrl: await startCheckout(req, pick(b.provider), b.items) });
});

// agentic tipping: the ai proposes a plan from updates the person already liked. nothing is charged until they approve it and pay.
const planLimit = rateLimit({ windowMs: 3_600_000, limit: 30, keyGenerator: (r) => String(r.userId), standardHeaders: true, legacyHeaders: false, validate: false });
paymentRoutes.post("/tips/plan", planLimit, async (req, res) => {
  const b = parse(z.object({ instruction: z.string().max(400).default(""), budget: z.number().positive().max(100_000), provider: z.string() }), req.body);
  const p = pick(b.provider); const s = await settings(); const cands = await candidates(req.userId!);
  const plan = await planTips(b.instruction, Math.round(b.budget * 100), minTip(p, s), cands);
  res.json({ currency: p.currency, summary: plan.summary, aiUsed: plan.aiUsed, items: plan.items.map((i) => ({ update: cands.find((c) => c.id === i.id), amount: i.amountMinor / 100, reason: i.reason })) });
});

// after approving on paypal the buyer returns here and we capture the order. the webhook is the backup path.
paymentRoutes.post("/paypal/capture", async (req, res) => {
  const { orderId } = parse(z.object({ orderId: z.string().min(5).max(64).regex(/^[A-Za-z0-9-]+$/) }), req.body);
  const p = providers.paypal; if (!p?.capture) throw new ApiError(501, "payments_not_configured", "paypal is not configured");
  const tips = await Tip.find({ checkoutId: orderId, tipper: req.userId, provider: "paypal" }); if (!tips.length) throw notFound("payment");
  const cap = await p.capture(orderId); let credited = 0;
  for (const u of cap.units) { const tip = tips.find((t) => t.reference === u.customId); if (tip && (await settleTip(tip, u.amount, u.currency))) credited++; }
  res.json({ completed: cap.completed, credited, total: tips.length });
});

async function owner(req: { userId?: string }, orgId?: string) {
  if (!orgId) return { kind: "user" as const, id: req.userId! };
  const m = await Membership.findOne({ org: oid(orgId, "organization"), user: req.userId });
  if (!m || !can(m.role, "wallet")) throw forbidden("only the organization owner can use the wallet");
  return { kind: "org" as const, id: orgId };
}
paymentRoutes.get("/wallet", async (req, res) => {
  const o = await owner(req, typeof req.query.org === "string" ? req.query.org : undefined);
  const [wallets, entries, wds, s] = await Promise.all([balances(o.kind, o.id), Ledger.find({ kind: o.kind, owner: o.id }).sort({ _id: -1 }).limit(50), Withdrawal.find({ kind: o.kind, owner: o.id }, "-bank.numberEnc -paypal.enc").sort({ _id: -1 }).limit(20), settings()]);
  res.json({ wallets, entries, withdrawals: wds, withdrawalsEnabled: encryptionReady, minimums: { [env.PAYMENT_CURRENCY]: s.minWithdrawalKobo, [env.PAYPAL_CURRENCY]: s.minWithdrawalPaypalMinor } });
});
const wdLimit = rateLimit({ windowMs: 86_400_000, limit: 5, keyGenerator: (req) => String(req.userId), standardHeaders: true, legacyHeaders: false, validate: false });
const base = { org: z.string().optional(), amount: amountSchema };
paymentRoutes.post("/wallet/withdrawals", wdLimit, async (req, res) => {
  const b = parse(z.discriminatedUnion("method", [
    z.object({ ...base, method: z.literal("bank"), bankCode: z.string().regex(/^\d{3,10}$/), bankName: z.string().max(80).optional(), accountNumber: z.string().regex(/^\d{10}$/), accountName: z.string().trim().min(3).max(100) }),
    z.object({ ...base, method: z.literal("paypal"), paypalEmail: z.string().email().max(120) }),
  ]), req.body);
  if (!encryptionReady) throw new ApiError(503, "withdrawals_unavailable", "withdrawals are not available yet");
  const me = await User.findById(req.userId, "emailVerified"); if (!me?.emailVerified) throw forbidden("verify your email first");
  const o = await owner(req, b.org); const s = await settings();
  const currency = b.method === "bank" ? env.PAYMENT_CURRENCY : env.PAYPAL_CURRENCY; // each method pays out one currency
  if (b.amount < (b.method === "bank" ? s.minWithdrawalKobo : s.minWithdrawalPaypalMinor)) throw new ApiError(400, "amount_too_small", "that is below the minimum withdrawal");
  // atomic hold: the balance only drops if it is large enough, so two requests can never overdraw
  const held = await Wallet.findOneAndUpdate({ kind: o.kind, owner: o.id, currency, balance: { $gte: b.amount } }, { $inc: { balance: -b.amount } });
  if (!held) throw new ApiError(400, "insufficient_balance", `your ${currency} balance is too low`);
  const w = await Withdrawal.create({ kind: o.kind, owner: o.id, requestedBy: req.userId, amount: b.amount, currency, method: b.method,
    ...(b.method === "bank" ? { bank: { bankCode: b.bankCode, bankName: b.bankName, accountName: b.accountName, last4: b.accountNumber.slice(-4), numberEnc: encryptField(b.accountNumber) } } : { paypal: { enc: encryptField(b.paypalEmail), hint: `${b.paypalEmail[0]}***@${b.paypalEmail.split("@")[1]}` } }) });
  await Ledger.create({ kind: o.kind, owner: o.id, currency, type: "debit", amount: -b.amount, ref: `hold:${w._id}`, note: "withdrawal requested" });
  const { bank, paypal, ...rest } = w.toObject(); void bank; void paypal;
  res.status(201).json({ withdrawal: rest });
});
