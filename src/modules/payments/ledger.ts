import { notify } from "@/modules/notifications/notifications";
import { Ledger, Wallet, Withdrawal } from "./models";

type Kind = "user" | "org" | "platform";
/** one tip split. integer minor units only. */
export function computeSplit(amount: number, feeBps: number, mode: string, orgPercent: number, hasPoster: boolean) {
  const fee = Math.floor((amount * feeBps) / 10_000), net = amount - fee;
  if (mode === "shared" && hasPoster) { const org = Math.floor((net * orgPercent) / 100); return { fee, org, poster: net - org }; }
  return { fee, org: net, poster: 0 }; // attribution and org only modes pay the organization, attribution is display only
}

/** inserts the ledger row first. a duplicate row means this change already happened, so nothing is credited twice. */
export async function move(kind: Kind, owner: string, currency: string, ref: string, amount: number, note?: string) {
  if (!amount) return;
  try { await Ledger.create({ kind, owner, currency, type: amount > 0 ? "credit" : "debit", amount, ref, note }); } catch (e) { if ((e as { code?: number }).code === 11000) return; throw e; }
  await Wallet.updateOne({ kind, owner, currency }, { $inc: { balance: amount } }, { upsert: true });
}
export async function balances(kind: Kind, owner: string) { return (await Wallet.find({ kind, owner })).map((w) => ({ currency: w.currency, balance: w.balance })); }

export async function creditTip(tip: { _id: unknown; org?: unknown; poster?: unknown; currency?: string | null; split?: { org?: number | null; poster?: number | null; fee?: number | null } | null }) {
  const id = String(tip._id), s = tip.split ?? {}, cur = tip.currency ?? "NGN";
  if (tip.org) await move("org", String(tip.org), cur, `tip:${id}`, s.org ?? 0, "tip");
  if (tip.poster) await move("user", String(tip.poster), cur, `tip:${id}`, s.poster ?? 0, "tip");
  await move("platform", "platform", cur, `fee:${id}`, s.fee ?? 0, "platform fee");
}

/** payouts are made by hand (or through the paypal payouts api), then confirmed here. */
export async function markWithdrawalPaid(id: string, admin: string, reference: string) {
  const w = await Withdrawal.findOneAndUpdate({ _id: id, status: "requested" }, { status: "paid", reference, decidedBy: admin, decidedAt: new Date() }, { new: true });
  if (w?.requestedBy) await notify(w.requestedBy, "wallet", "your withdrawal was paid", "/app/wallet", w.kind === "org" ? w.owner ?? undefined : undefined);
  return w;
}
export async function rejectWithdrawal(id: string, admin: string, note: string) {
  const w = await Withdrawal.findOneAndUpdate({ _id: id, status: "requested" }, { status: "rejected", note, decidedBy: admin, decidedAt: new Date() }, { new: true });
  if (w) { await move(w.kind as Kind, w.owner!, w.currency!, `hold-reversal:${w._id}`, w.amount ?? 0, "withdrawal rejected"); if (w.requestedBy) await notify(w.requestedBy, "wallet", "your withdrawal was rejected and the money is back in your wallet", "/app/wallet", w.kind === "org" ? w.owner ?? undefined : undefined); }
  return w;
}
