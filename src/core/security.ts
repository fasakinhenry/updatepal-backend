import { createHash, randomBytes } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "./env";
import { ApiError, forbidden, notFound, oid, unauthorized } from "./http";
import { isAdminEmail } from "./env";
import { User } from "@/modules/auth/models";
import { can, type Cap } from "./caps";
import { Membership } from "@/modules/orgs/models";

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const randomToken = () => randomBytes(32).toString("base64url");
export const signAccess = (userId: string) => jwt.sign({ sub: userId }, env.JWT_SECRET, { expiresIn: "15m", algorithm: "HS256" });

// short lived cache so suspension takes effect within seconds without a database read on every request
const seen = new Map<string, { susp: boolean; at: number; touched: number }>();
export const forgetUser = (id: string) => { seen.delete(id); };
export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const h = req.headers.authorization;
  if (!h?.startsWith("Bearer ")) return next(unauthorized());
  let id: string;
  try { const p = jwt.verify(h.slice(7), env.JWT_SECRET, { algorithms: ["HS256"] }); id = String(typeof p === "string" ? p : p.sub); }
  catch { return next(unauthorized("session expired", "session_expired")); }
  try {
    let c = seen.get(id);
    if (!c || Date.now() - c.at > 30_000) {
      const u = await User.findById(id, "suspended lastSeenAt");
      if (!u) return next(unauthorized());
      c = { susp: !!u.suspended, at: Date.now(), touched: u.lastSeenAt?.getTime() ?? 0 };
      if (Date.now() - c.touched > 600_000) { await User.updateOne({ _id: id }, { lastSeenAt: new Date() }); c.touched = Date.now(); } // powers the active users numbers
      if (seen.size > 5000) seen.clear();
      seen.set(id, c);
    }
    if (c.susp) return next(new ApiError(403, "account_suspended", "your account is suspended. contact support."));
    req.userId = id; next();
  } catch (e) { next(e); }
}
/** only a verified account whose email is ADMIN_EMAIL gets through. everyone else sees a 404. */
export async function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  try { const u = await User.findById(req.userId, "email emailVerified"); if (!u || !u.emailVerified || !isAdminEmail(u.email)) throw notFound("route"); next(); } catch (e) { next(e); }
}

/** loads the caller's membership in :orgId and enforces a capability. other orgs never leak into this check. */
export const orgGuard = (cap?: Cap) => async (req: Request, _res: Response, next: NextFunction) => {
  try {
    const orgId = oid(req.params.orgId, "organization");
    const m = await Membership.findOne({ org: orgId, user: req.userId });
    if (!m) throw forbidden("you are not a member of this organization");
    if (cap && !can(m.role, cap, m.grants)) throw forbidden(`your role cannot do this (needs ${cap})`);
    req.role = m.role; req.grants = m.grants ?? []; req.channels = m.channels ?? []; next();
  } catch (e) { next(e); }
};
