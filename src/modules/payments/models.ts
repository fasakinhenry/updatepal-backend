import { Schema, model } from "mongoose";

export const Tip = model("Tip", new Schema({
  tipper: { type: Schema.Types.ObjectId, required: true, index: true }, update: Schema.Types.ObjectId, org: { type: Schema.Types.ObjectId, index: true }, poster: Schema.Types.ObjectId,
  provider: String, batch: { type: String, index: true },
  amount: { type: Number, required: true }, currency: String, // minor units (kobo or cents)
  split: { org: Number, poster: Number, fee: Number },
  status: { type: String, enum: ["pending", "paid", "expired", "failed", "mismatch"], default: "pending", index: true },
  title: String, reference: { type: String, unique: true }, checkoutId: { type: String, index: true }, paidAt: Date,
}, { timestamps: true }));

// wallet balances are updated atomically. every change also writes an append only ledger row.
export const Wallet = model("Wallet", (() => { const s = new Schema({ kind: { type: String, enum: ["user", "org", "platform"], required: true }, owner: { type: String, required: true }, currency: { type: String, required: true }, balance: { type: Number, default: 0 } }, { timestamps: true }); s.index({ kind: 1, owner: 1, currency: 1 }, { unique: true }); return s; })());
export const Ledger = model("Ledger", (() => { const s = new Schema({ kind: String, owner: String, currency: String, type: String, amount: Number, ref: { type: String, required: true }, note: String }, { timestamps: true }); s.index({ kind: 1, owner: 1, ref: 1 }, { unique: true }); return s; })());

export const Withdrawal = model("Withdrawal", new Schema({
  kind: { type: String, enum: ["user", "org"] }, owner: { type: String, index: true }, requestedBy: Schema.Types.ObjectId,
  amount: Number, currency: String, method: { type: String, enum: ["bank", "paypal"], default: "bank" },
  paypal: { enc: String, hint: String }, // the paypal email is encrypted at rest
  bank: { bankCode: String, bankName: String, accountName: String, last4: String, numberEnc: String }, // the full number is encrypted at rest
  status: { type: String, enum: ["requested", "paid", "rejected"], default: "requested", index: true },
  reference: String, note: String, decidedBy: Schema.Types.ObjectId, decidedAt: Date,
}, { timestamps: true }));
export const WebhookEvent = model("WebhookEvent", new Schema({ _id: String, type: String, at: { type: Date, default: Date.now, expires: 60 * 86400 } }));
