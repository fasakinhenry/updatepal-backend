import { Schema, model } from "mongoose";

export const AuditLog = model("AuditLog", new Schema({ actor: Schema.Types.ObjectId, actorEmail: String, action: { type: String, index: true }, target: String, detail: Schema.Types.Mixed, ip: String }, { timestamps: true }));
export const AiLog = model("AiLog", new Schema({ kind: String, provider: String, model: String, ok: Boolean, ms: Number, createdAt: { type: Date, default: Date.now, index: true } }));
