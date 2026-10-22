import express, { Router } from "express";
import { Schema, model } from "mongoose";
import { z } from "zod";
import { env } from "@/core/env";
import { ApiError, forbidden, notFound, oid, parse } from "@/core/http";
import { orgGuard, requireAuth } from "@/core/security";
import { storage } from "@/core/storage";

const kinds = ["folder", "pdf", "docx", "xlsx", "pptx", "csv", "txt", "image"] as const;
export const Doc = model("Doc", new Schema({
  org: { type: Schema.Types.ObjectId, required: true, index: true }, name: { type: String, required: true }, kind: { type: String, enum: kinds, required: true },
  parent: { type: Schema.Types.ObjectId, default: null }, size: { type: Number, default: 0 }, mime: String, uploadedBy: Schema.Types.ObjectId,
  vis: { type: String, enum: ["public", "members", "restricted", "private"], default: "members" },
  storageKey: String, // never exposed. files are only served through authorized routes.
}, { timestamps: true }));

const O = (req: { params: unknown }) => (req.params as Record<string, string>).orgId;
export const documentRoutes = Router({ mergeParams: true });
documentRoutes.use(requireAuth, orgGuard("documents"));
const seen = (userId: string) => ({ $or: [{ vis: { $ne: "private" } }, { uploadedBy: userId }] });
const bare = (d: InstanceType<typeof Doc>) => { const { storageKey, ...rest } = d.toObject(); void storageKey; return rest; };

documentRoutes.get("/", async (req, res) => {
  const parent = req.query.parent ? oid(req.query.parent, "folder") : null;
  const items = await Doc.find({ org: O(req), parent, ...seen(req.userId!) }).sort({ kind: 1, name: 1 }).limit(500);
  res.json({ items: items.map(bare) });
});
documentRoutes.post("/", async (req, res) => {
  const b = parse(z.object({ name: z.string().trim().min(1).max(160).refine((n) => !/[\\/]/.test(n), "no slashes in names"), kind: z.enum(kinds), parent: z.string().nullable().optional(), vis: z.enum(["public", "members", "restricted", "private"]).default("members"), mime: z.string().max(100).optional() }), req.body);
  if (b.parent) { const p = await Doc.findOne({ _id: oid(b.parent, "folder"), org: O(req), kind: "folder" }); if (!p) throw notFound("folder"); } // parents must be in the same org
  const d = await Doc.create({ ...b, parent: b.parent ?? null, org: O(req), uploadedBy: req.userId });
  res.status(201).json({ document: bare(d), uploadPath: b.kind === "folder" ? undefined : `/api/orgs/${O(req)}/documents/${d._id}/content` });
});
documentRoutes.patch("/:id", async (req, res) => {
  const b = parse(z.object({ name: z.string().trim().min(1).max(160), vis: z.enum(["public", "members", "restricted", "private"]), parent: z.string().nullable() }).partial().strict(), req.body);
  if (b.parent) { if (!(await Doc.exists({ _id: oid(b.parent, "folder"), org: O(req), kind: "folder" }))) throw notFound("folder"); }
  const d = await Doc.findOneAndUpdate({ _id: oid(req.params.id, "document"), org: O(req), ...seen(req.userId!) }, b, { new: true }); if (!d) throw notFound("document");
  res.json({ document: bare(d) });
});
documentRoutes.delete("/:id", async (req, res) => {
  const d = await Doc.findOne({ _id: oid(req.params.id, "document"), org: O(req), ...seen(req.userId!) }); if (!d) throw notFound("document");
  if (d.kind === "folder" && (await Doc.exists({ parent: d._id }))) throw new ApiError(409, "folder_not_empty", "empty the folder first");
  if (d.storageKey) await storage.remove(d.storageKey);
  await d.deleteOne(); res.json({ ok: true });
});
// backend mediated upload. swap the storage driver for signed urls without changing the client contract.
documentRoutes.put("/:id/content", express.raw({ type: () => true, limit: `${env.MAX_UPLOAD_MB}mb` }), async (req, res) => {
  const d = await Doc.findOne({ _id: oid(req.params.id, "document"), org: O(req), kind: { $ne: "folder" }, ...seen(req.userId!) }); if (!d) throw notFound("document");
  if (!Buffer.isBuffer(req.body) || !req.body.length) throw new ApiError(400, "empty_upload", "no file data received");
  if (d.storageKey) await storage.remove(d.storageKey);
  d.storageKey = await storage.put(req.body); d.size = req.body.length; await d.save();
  res.json({ document: bare(d) });
});
documentRoutes.get("/:id/content", async (req, res) => {
  const d = await Doc.findOne({ _id: oid(req.params.id, "document"), org: O(req), ...seen(req.userId!) }); if (!d?.storageKey) throw notFound("file");
  if (d.vis === "private" && String(d.uploadedBy) !== req.userId) throw forbidden();
  res.setHeader("Content-Type", "application/octet-stream"); // untrusted files are never rendered inline by the browser
  res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(d.name)}"`);
  res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("Cache-Control", "private, no-store");
  (await storage.read(d.storageKey)).pipe(res);
});
