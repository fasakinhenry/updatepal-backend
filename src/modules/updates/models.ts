import { Schema, model } from "mongoose";

export const Update = model("Update", new Schema({
  org: { type: Schema.Types.ObjectId, required: true, index: true }, author: { type: Schema.Types.ObjectId, required: true },
  cat: { type: String, index: true }, title: { type: String, required: true }, body: { type: String, required: true },
  tags: { type: [String], index: true }, images: [String], deadline: String, place: String, link: String,
  number: Number, // assigned by the server when published
  hidden: { type: Boolean, default: false, index: true }, hiddenReason: String, // removed by moderation or an organization suspension
  counts: { loves: { type: Number, default: 0 }, comments: { type: Number, default: 0 } },
}, { timestamps: true }));

const pair = () => { const s = new Schema({ user: { type: Schema.Types.ObjectId, required: true }, target: { type: Schema.Types.ObjectId, required: true } }, { timestamps: true }); s.index({ user: 1, target: 1 }, { unique: true }); return s; };
export const Reaction = model("Reaction", pair());
const bm = new Schema({ user: { type: Schema.Types.ObjectId, required: true }, target: { type: Schema.Types.ObjectId, required: true }, kind: { type: String, enum: ["update", "story"], default: "update" } }, { timestamps: true });
bm.index({ user: 1, target: 1 }, { unique: true });
export const Bookmark = model("Bookmark", bm);

export const Comment = model("Comment", new Schema({
  update: { type: Schema.Types.ObjectId, required: true, index: true }, author: { type: Schema.Types.ObjectId, required: true },
  asOrg: Schema.Types.ObjectId, parent: Schema.Types.ObjectId, body: { type: String, required: true }, hidden: { type: Boolean, default: false },
}, { timestamps: true }));

const followSchema = new Schema({ follower: { type: Schema.Types.ObjectId, required: true }, kind: { type: String, enum: ["org", "user"], required: true }, target: { type: String, required: true } }, { timestamps: true });
followSchema.index({ follower: 1, kind: 1, target: 1 }, { unique: true });
export const Follow = model("Follow", followSchema);
