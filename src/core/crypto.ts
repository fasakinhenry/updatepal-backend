import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "./env";

// encrypts small sensitive fields (payout bank details) at rest with aes-256-gcm.
const key = env.DATA_ENCRYPTION_KEY ? Buffer.from(env.DATA_ENCRYPTION_KEY, "base64") : null;
export const encryptionReady = !!key && key.length === 32;
export function encryptField(plain: string): string {
  if (!key || key.length !== 32) throw new Error("DATA_ENCRYPTION_KEY is not set");
  const iv = randomBytes(12), c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), ct].map((b) => b.toString("base64")).join(".");
}
export function decryptField(blob: string): string {
  if (!key || key.length !== 32) throw new Error("DATA_ENCRYPTION_KEY is not set");
  const [iv, tag, ct] = blob.split(".").map((p) => Buffer.from(p, "base64"));
  const d = createDecipheriv("aes-256-gcm", key, iv); d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
}
