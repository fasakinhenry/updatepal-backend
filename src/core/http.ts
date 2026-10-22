import type { NextFunction, Request, Response } from "express";
import { isValidObjectId } from "mongoose";
import type { ZodTypeAny, z } from "zod";

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) { super(message); }
}
export const unauthorized = (m = "sign in required", code = "unauthorized") => new ApiError(401, code, m);
export const forbidden = (m = "you do not have permission for this") => new ApiError(403, "forbidden", m);
export const notFound = (what = "resource") => new ApiError(404, "not_found", `${what} not found`);
export const conflict = (code: string, m: string) => new ApiError(409, code, m);

export function parse<T extends ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) throw new ApiError(400, "validation_error", "check the highlighted fields", r.error.flatten().fieldErrors);
  return r.data;
}
/** route params must be valid object ids, otherwise treat as missing. */
export function oid(id: unknown, what = "resource"): string {
  if (typeof id !== "string" || !isValidObjectId(id)) throw notFound(what);
  return id;
}

// consistent error shape: { error: { code, message, details? } }
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ApiError) return void res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
  const e = err as { code?: number; keyPattern?: Record<string, unknown>; type?: string };
  if (e?.code === 11000) return void res.status(409).json({ error: { code: "conflict", message: `that ${Object.keys(e.keyPattern ?? {})[0] ?? "value"} is already taken` } });
  if (e?.type === "entity.too.large") return void res.status(413).json({ error: { code: "too_large", message: "request is too large" } });
  console.error(err);
  res.status(500).json({ error: { code: "server_error", message: "something went wrong on our side" } });
}
