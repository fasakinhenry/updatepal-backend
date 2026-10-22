import { Schema, model } from "mongoose";

export const Story = model("Story", new Schema({
  author: { type: Schema.Types.ObjectId, required: true, index: true }, title: { type: String, default: "" }, body: { type: String, required: true },
  refs: [Schema.Types.ObjectId], images: [String], celebrations: { type: Number, default: 0 }, hidden: { type: Boolean, default: false },
}, { timestamps: true }));
const c = new Schema({ user: { type: Schema.Types.ObjectId, required: true }, target: { type: Schema.Types.ObjectId, required: true } }, { timestamps: true });
c.index({ user: 1, target: 1 }, { unique: true });
export const Celebration = model("Celebration", c);
