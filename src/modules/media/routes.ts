import express, { Router } from "express";
import rateLimit from "express-rate-limit";
import { Schema, model } from "mongoose";
import { z } from "zod";
import { env } from "@/core/env";
import { ApiError, notFound, oid, parse } from "@/core/http";
import { requireAuth } from "@/core/security";
import { storage } from "@/core/storage";

const Media = model("Media", new Schema({ owner: Schema.Types.ObjectId, kind: String, mime: String, size: Number, key: String }, { timestamps: true }));
const base = `${env.API_PUBLIC_URL ?? `http://localhost:${env.PORT}`}/api/media/`;
/** true for links to images uploaded through this api. used by validators that otherwise require https. */
export const mediaUrlOk = (u: string) => u.startsWith(base) && /^[a-f0-9]{24}$/.test(u.slice(base.length));

// images are checked by their first bytes, never by the name or the type the browser claims. svg is not allowed.
function sniff(b: Buffer): string | null {
  if (b.length > 12 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length > 6 && b.subarray(0, 4).toString("ascii") === "GIF8") return "image/gif";
  if (b.length > 12 && b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

export const mediaPublic = Router(); // avatars, logos and post images are public by nature
mediaPublic.get("/:id", async (req, res) => {
  const m = await Media.findById(oid(req.params.id, "image")); if (!m?.key) throw notFound("image");
  res.setHeader("Content-Type", m.mime ?? "application/octet-stream"); res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin"); res.setHeader("Cache-Control", "public, max-age=604800, immutable");
  (await storage.read(m.key)).pipe(res);
});

export const mediaRoutes = Router();
mediaRoutes.use(requireAuth, rateLimit({ windowMs: 3_600_000, limit: 60, keyGenerator: (r) => String(r.userId), standardHeaders: true, legacyHeaders: false, validate: false }));
mediaRoutes.put("/", express.raw({ type: () => true, limit: "5mb" }), async (req, res) => {
  const { kind } = parse(z.object({ kind: z.enum(["avatar", "logo", "banner", "story", "update"]) }), req.query);
  const body = req.body as Buffer; const mime = Buffer.isBuffer(body) ? sniff(body) : null;
  if (!mime) throw new ApiError(400, "unsupported_image", "use a png, jpeg, webp or gif image up to 5 mb");
  const key = await storage.put(body);
  const m = await Media.create({ owner: req.userId, kind, mime, size: body.length, key });
  res.status(201).json({ url: `${base}${m._id}` });
});
