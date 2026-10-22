import { Schema, model } from "mongoose";

const userSchema = new Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  emailVerified: { type: Boolean, default: false },
  passwordHash: String,
  googleId: { type: String, unique: true, sparse: true },
  name: { type: String, default: "" },
  username: { type: String, unique: true, sparse: true, lowercase: true },
  avatar: String, bio: { type: String, default: "" },
  gender: String, dob: Date,
  interests: [String],
  location: { city: String, country: String, remote: Boolean, relocate: Boolean },
  onboarded: { type: Boolean, default: false },
  prefs: { updates: { type: Boolean, default: true }, comments: { type: Boolean, default: true }, mentions: { type: Boolean, default: true }, follows: { type: Boolean, default: true } },
  links: [String],
  payments: { preferred: { type: String, enum: ["bachs", "paypal"] }, paypalEmail: String }, // the checkout method pre-selected for tips, and where paypal payouts go
  visibility: { type: String, enum: ["public", "followers", "members", "private"], default: "public" },
  acceptsDms: { type: Boolean, default: true },
  suspended: { type: Boolean, default: false }, suspendedReason: String, lastSeenAt: Date,
  // end to end encryption. the server only ever holds the public key and a passcode encrypted backup of the private key.
  e2ee: { publicKey: String, wrapped: String, salt: String, iv: String, iterations: Number },
}, { timestamps: true });
export const User = model("User", userSchema);

// refresh sessions. only a hash of the token is stored. expired rows are removed by mongo.
export const Session = model("Session", new Schema({
  user: { type: Schema.Types.ObjectId, index: true, required: true },
  tokenHash: { type: String, unique: true, required: true },
  expiresAt: { type: Date, expires: 0, required: true }, userAgent: String,
}, { timestamps: true }));
// one time tokens for email verification and password reset
export const OneTimeToken = model("OneTimeToken", new Schema({
  user: { type: Schema.Types.ObjectId, required: true }, kind: { type: String, enum: ["verify", "reset"], required: true },
  hash: { type: String, unique: true, required: true }, expiresAt: { type: Date, expires: 0, required: true },
}));
