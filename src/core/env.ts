import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(4000),
  MONGODB_URI: z.string().min(1),
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  CLIENT_ORIGIN: z.string().url().default("http://localhost:5173"),
  GOOGLE_CLIENT_ID: z.string().optional(),
  // ai provider is swappable. gemini has a free tier. add another provider by implementing AiProvider in core/ai.ts.
  AI_PROVIDER: z.enum(["gemini", "anthropic", "none"]).default("gemini"),
  GEMINI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  AI_MODEL: z.string().optional(),
  // only this verified email can open the admin area
  ADMIN_EMAIL: z.string().optional(),
  // comma separated list: bachs, paypal. users pick one at checkout. leave empty to turn payments off.
  PAYMENT_PROVIDERS: z.string().default(""),
  PAYMENT_PROVIDER: z.string().optional(), // legacy single value, still read when PAYMENT_PROVIDERS is empty
  BACHS_API_KEY: z.string().optional(),
  PAYPAL_CLIENT_ID: z.string().optional(),
  PAYPAL_CLIENT_SECRET: z.string().optional(),
  PAYPAL_ENV: z.enum(["sandbox", "live"]).default("sandbox"),
  PAYPAL_WEBHOOK_ID: z.string().optional(),
  PAYPAL_CURRENCY: z.string().length(3).default("USD"),
  // set to true to let admins pay approved withdrawals through the paypal payouts api (needs payouts enabled on your paypal account)
  PAYPAL_PAYOUTS: z.enum(["true", "false"]).default("false"),
  // public base url of this api, used for uploaded image links
  API_PUBLIC_URL: z.string().url().optional(),
  BACHS_WEBHOOK_SECRET: z.string().optional(),
  PAYMENT_CURRENCY: z.string().length(3).default("NGN"),
  PLATFORM_FEE_BPS: z.coerce.number().int().min(0).max(5000).default(0),
  // base64 of 32 random bytes. encrypts payout bank details at rest.
  DATA_ENCRYPTION_KEY: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  MAIL_FROM: z.string().default("updatebase <onboarding@resend.dev>"),
  // local disk is fine for development only. hosts with ephemeral disks (render free tier) lose local files on every deploy, so use s3 there.
  STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
  STORAGE_DIR: z.string().default("./storage"),
  S3_BUCKET: z.string().optional(), S3_REGION: z.string().default("auto"), S3_ENDPOINT: z.string().url().optional(), // set for r2, backblaze, minio and other s3 compatible stores
  S3_ACCESS_KEY_ID: z.string().optional(), S3_SECRET_ACCESS_KEY: z.string().optional(),
  MAX_UPLOAD_MB: z.coerce.number().default(25),
});
export const env = schema.parse(process.env);
export const isProd = env.NODE_ENV === "production";
export const adminEmails = (env.ADMIN_EMAIL ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
export const isAdminEmail = (email?: string | null) => !!email && adminEmails.includes(email.toLowerCase());
