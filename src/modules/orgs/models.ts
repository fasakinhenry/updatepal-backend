import { Schema, model } from "mongoose";
import { roles } from "@/core/caps";

const orgSchema = new Schema({
  handle: { type: String, required: true, unique: true, lowercase: true },
  name: { type: String, required: true }, category: String, description: { type: String, default: "" }, bio: { type: String, default: "" },
  logo: String, banner: String, owner: { type: Schema.Types.ObjectId, required: true },
  rules: {
    lowercase: { type: Boolean, default: false }, numbering: { type: Boolean, default: false }, prefix: { type: String, default: "" },
    footer: { type: String, default: "" }, link: { type: String, default: "" }, attribution: { type: Boolean, default: false },
    handle: { type: String, default: "" }, instructions: { type: String, default: "" }, requireReview: { type: Boolean, default: false },
    tone: { type: String, default: "" }, categories: { type: [String], default: [] }, maxLength: { type: Number, default: 900 }, useExamples: { type: Boolean, default: true },
  },
  // the authoritative update number. allocated atomically when an update is published.
  nextNumber: { type: Number, default: 1 },
  tipMode: { type: String, enum: ["attribution", "shared", "org"], default: "shared" }, feedbackPublic: { type: Boolean, default: false }, tipOrgPercent: { type: Number, default: 70 }, suspended: { type: Boolean, default: false }, paypalEmail: String,
}, { timestamps: true });
export const Org = model("Org", orgSchema);

const membershipSchema = new Schema({ org: { type: Schema.Types.ObjectId, required: true }, user: { type: Schema.Types.ObjectId, required: true, index: true }, role: { type: String, enum: roles, required: true }, grants: { type: [String], default: [] }, channels: { type: [String], default: [] } }, { timestamps: true });
membershipSchema.index({ org: 1, user: 1 }, { unique: true });
export const Membership = model("Membership", membershipSchema);

export const Invitation = model("Invitation", new Schema({
  org: { type: Schema.Types.ObjectId, required: true, index: true }, role: { type: String, enum: roles, required: true },
  via: { type: String, enum: ["email", "username", "link"], required: true }, email: String, username: String,
  tokenHash: { type: String, unique: true, required: true }, invitedBy: Schema.Types.ObjectId,
  status: { type: String, enum: ["pending", "accepted", "declined", "expired", "revoked"], default: "pending" },
  expiresAt: { type: Date, required: true },
}, { timestamps: true }));
