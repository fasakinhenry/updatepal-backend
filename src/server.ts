import mongoose from "mongoose";
import { app } from "./app";
import { env, isProd } from "@/core/env";
import { startScheduler } from "@/modules/publishing/routes";

// warn about settings that usually mean a mistake in production
if (isProd) {
  if (/localhost|127\.0\.0\.1/.test(env.CLIENT_ORIGIN)) console.warn("CLIENT_ORIGIN points at localhost. cors and email links will be wrong.");
  if (!env.ADMIN_EMAIL) console.warn("ADMIN_EMAIL is not set. nobody can open the admin area.");
  if (!env.RESEND_API_KEY) console.warn("RESEND_API_KEY is not set. verification and reset emails will not be sent.");
  if (env.STORAGE_DRIVER === "local") console.warn("STORAGE_DRIVER=local. files are lost on hosts with an ephemeral disk. use s3.");
  if (!env.API_PUBLIC_URL) console.warn("API_PUBLIC_URL is not set. uploaded image links will point at localhost.");
}
process.on("unhandledRejection", (e) => console.error("unhandled rejection", e));
process.on("uncaughtException", (e) => console.error("uncaught exception", e));

await mongoose.connect(env.MONGODB_URI, { bufferCommands: false }); // fail fast instead of hanging when the database is down
const server = app.listen(env.PORT, () => console.log(`updatebase api listening on ${env.PORT}`));
startScheduler();

// finish in flight requests on deploys and restarts
const stop = () => { server.close(() => void mongoose.disconnect().finally(() => process.exit(0))); setTimeout(() => process.exit(1), 10_000).unref(); };
process.on("SIGTERM", stop); process.on("SIGINT", stop);
