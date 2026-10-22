import { createReadStream } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { env } from "./env";

// storage port. routes only use this interface, so the driver can change without touching them.
// keys are random and never come from user input. nothing is served from a public bucket: files go through authorized routes.
export interface Storage {
  put(data: Buffer): Promise<string>;
  read(key: string): Promise<Readable>;
  remove(key: string): Promise<void>;
}
const safe = (k: string) => /^[a-f0-9]{32}$/.test(k);
const newKey = () => randomBytes(16).toString("hex");

const local: Storage = {
  async put(data) { await mkdir(env.STORAGE_DIR, { recursive: true }); const key = newKey(); await writeFile(join(env.STORAGE_DIR, key), data); return key; },
  async read(key) { if (!safe(key)) throw new Error("bad key"); return createReadStream(join(env.STORAGE_DIR, key)); },
  async remove(key) { if (safe(key)) await unlink(join(env.STORAGE_DIR, key)).catch(() => undefined); },
};

function s3(): Storage {
  if (!env.S3_BUCKET || !env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY) throw new Error("S3 storage needs S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY");
  const Bucket = env.S3_BUCKET;
  const endpoint = env.S3_ENDPOINT ?? (env.STORAGE_PROVIDER === "b2" ? `https://s3.${env.S3_REGION}.backblazeb2.com` : undefined);
  if (env.STORAGE_PROVIDER === "r2" && !endpoint) throw new Error("STORAGE_PROVIDER=r2 needs S3_ENDPOINT");
  if (env.STORAGE_PROVIDER === "custom" && !endpoint) throw new Error("STORAGE_PROVIDER=custom needs S3_ENDPOINT");
  const c = new S3Client({ region: env.S3_REGION, endpoint, forcePathStyle: env.STORAGE_PROVIDER === "custom" || env.STORAGE_PROVIDER === "b2" || !!env.S3_ENDPOINT, credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY } });
  return {
    async put(data) { const Key = newKey(); await c.send(new PutObjectCommand({ Bucket, Key, Body: data })); return Key; },
    async read(Key) { if (!safe(Key)) throw new Error("bad key"); const r = await c.send(new GetObjectCommand({ Bucket, Key })); return Readable.from(Buffer.from(await r.Body!.transformToByteArray())); }, // files are capped at 25 mb
    async remove(Key) { if (safe(Key)) await c.send(new DeleteObjectCommand({ Bucket, Key })).catch(() => undefined); },
  };
}
export const storage: Storage = env.STORAGE_PROVIDER === "local" ? local : s3();
