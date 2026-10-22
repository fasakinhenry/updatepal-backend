import { Router, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { OAuth2Client } from "google-auth-library";
import { z } from "zod";
import { env, isAdminEmail, isProd } from "@/core/env";
import { settings } from "@/core/settings";
import { ApiError, oid, parse, unauthorized } from "@/core/http";
import { sendMail } from "@/core/mailer";
import { randomToken, requireAuth, sha256, signAccess } from "@/core/security";
import { OneTimeToken, Session, User } from "./models";

export const authRoutes = Router();
authRoutes.use(rateLimit({ windowMs: 15 * 60_000, limit: 40, standardHeaders: true, legacyHeaders: false }));

const email = z.string().trim().toLowerCase().email().max(254);
const password = z.string().min(8).max(128);
const COOKIE = "ub_refresh";
const DAY = 86_400_000;
const cookieOpts = { httpOnly: true, secure: isProd, sameSite: (isProd ? "none" : "lax") as "none" | "lax", path: "/api/auth", maxAge: 30 * DAY };
// compared against when the account does not exist, so timing does not reveal which emails are registered
const dummyHash = await Bun.password.hash("not-a-real-password");

export const publicUser = (u: InstanceType<typeof User>) => ({
  id: String(u._id), email: u.email, emailVerified: u.emailVerified, name: u.name, username: u.username, avatar: u.avatar, bio: u.bio,
  interests: u.interests, location: u.location, onboarded: u.onboarded, visibility: u.visibility, acceptsDms: u.acceptsDms, hasPassword: !!u.passwordHash, hasGoogle: !!u.googleId, isAdmin: u.emailVerified && isAdminEmail(u.email), hasKeys: !!u.e2ee?.publicKey, prefs: { updates: u.prefs?.updates ?? true, comments: u.prefs?.comments ?? true, mentions: u.prefs?.mentions ?? true, follows: u.prefs?.follows ?? true }, links: u.links ?? [], payments: { preferred: u.payments?.preferred ?? null, paypalEmail: u.payments?.paypalEmail ?? "" },
});

async function startSession(req: Request, res: Response, user: InstanceType<typeof User>) {
  if (user.suspended) throw new ApiError(403, "account_suspended", "your account is suspended. contact support.");
  const token = randomToken();
  await Session.create({ user: user._id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + 30 * DAY), userAgent: req.get("user-agent")?.slice(0, 200) });
  res.cookie(COOKIE, token, cookieOpts);
  res.json({ accessToken: signAccess(String(user._id)), user: publicUser(user) });
}
async function mailToken(user: InstanceType<typeof User>, kind: "verify" | "reset") {
  const token = randomToken();
  await OneTimeToken.deleteMany({ user: user._id, kind });
  await OneTimeToken.create({ user: user._id, kind, hash: sha256(token), expiresAt: new Date(Date.now() + (kind === "verify" ? 2 * DAY : 3_600_000)) });
  const path = kind === "verify" ? "auth/verify" : "auth/reset";
  await sendMail(user.email, kind === "verify" ? "verify your email for updatebase" : "reset your updatebase password", `${kind === "verify" ? "confirm your email" : "choose a new password"}: ${env.CLIENT_ORIGIN}/${path}?token=${token}\n\nif this was not you, ignore this email.`);
}
const generic = (res: Response) => res.status(202).json({ message: "if that email can be used, we sent instructions to it" });

authRoutes.post("/register", async (req, res) => {
  const b = parse(z.object({ email, password, name: z.string().trim().max(80).optional() }), req.body);
  if (!(await User.exists({ email: b.email }))) {
    if (!(await settings()).registrationOpen && !isAdminEmail(b.email)) throw new ApiError(403, "registration_closed", "new sign ups are closed right now");
    const user = await User.create({ email: b.email, passwordHash: await Bun.password.hash(b.password), name: b.name ?? "" });
    await mailToken(user, "verify");
  }
  generic(res); // same answer whether or not the email exists
});
authRoutes.post("/login", async (req, res) => {
  const b = parse(z.object({ email, password: z.string().max(128) }), req.body);
  const user = await User.findOne({ email: b.email });
  const ok = await Bun.password.verify(b.password, user?.passwordHash ?? dummyHash);
  if (!user?.passwordHash || !ok) throw unauthorized("wrong email or password", "invalid_credentials");
  if (!user.emailVerified) throw new ApiError(403, "email_not_verified", "verify your email first");
  await startSession(req, res, user);
});
authRoutes.post("/verify-email", async (req, res) => {
  const { token } = parse(z.object({ token: z.string().min(10).max(100) }), req.body);
  const t = await OneTimeToken.findOneAndDelete({ hash: sha256(token), kind: "verify", expiresAt: { $gt: new Date() } });
  const user = t && (await User.findByIdAndUpdate(t.user, { emailVerified: true }, { new: true }));
  if (!user) throw new ApiError(400, "invalid_token", "this link is invalid or has expired");
  await startSession(req, res, user);
});
authRoutes.post("/resend-verification", async (req, res) => {
  const b = parse(z.object({ email }), req.body);
  const user = await User.findOne({ email: b.email, emailVerified: false });
  if (user) await mailToken(user, "verify");
  generic(res);
});
authRoutes.post("/forgot-password", async (req, res) => {
  const b = parse(z.object({ email }), req.body);
  const user = await User.findOne({ email: b.email });
  if (user) await mailToken(user, "reset");
  generic(res);
});
authRoutes.post("/reset-password", async (req, res) => {
  const b = parse(z.object({ token: z.string().min(10).max(100), password }), req.body);
  const t = await OneTimeToken.findOneAndDelete({ hash: sha256(b.token), kind: "reset", expiresAt: { $gt: new Date() } });
  if (!t) throw new ApiError(400, "invalid_token", "this link is invalid or has expired");
  await User.updateOne({ _id: t.user }, { passwordHash: await Bun.password.hash(b.password), emailVerified: true });
  await Session.deleteMany({ user: t.user }); // sign out everywhere
  res.json({ ok: true });
});

// google sign in. the id token is verified server side. accounts link only on a google verified email.
const google = env.GOOGLE_CLIENT_ID ? new OAuth2Client(env.GOOGLE_CLIENT_ID) : null;
authRoutes.post("/google", async (req, res) => {
  if (!google) throw new ApiError(501, "not_configured", "google sign in is not configured");
  const { idToken } = parse(z.object({ idToken: z.string().min(20).max(4000) }), req.body);
  const p = await google.verifyIdToken({ idToken, audience: env.GOOGLE_CLIENT_ID }).then((t) => t.getPayload()).catch(() => null);
  if (!p?.sub || !p.email || p.email_verified !== true) throw new ApiError(400, "unverified_google_email", "your google email is not verified");
  const mail = p.email.toLowerCase();
  let user = await User.findOne({ googleId: p.sub });
  if (!user) {
    user = await User.findOne({ email: mail });
    if (user) {
      // link. if the local account was never verified, drop its password so a pre registered attacker cannot keep access.
      user.googleId = p.sub;
      if (!user.emailVerified) user.passwordHash = undefined;
      user.emailVerified = true; if (!user.avatar && p.picture) user.avatar = p.picture;
      await user.save();
    } else if (!(await settings()).registrationOpen && !isAdminEmail(mail)) throw new ApiError(403, "registration_closed", "new sign ups are closed right now");
    else user = await User.create({ email: mail, emailVerified: true, googleId: p.sub, name: p.name ?? "", avatar: p.picture });
  }
  await startSession(req, res, user);
});

// account security: change or set a password, and review or revoke signed in devices
authRoutes.post("/change-password", requireAuth, async (req, res) => {
  const b = parse(z.object({ current: z.string().max(128).optional(), password }), req.body);
  const u = await User.findById(req.userId); if (!u) throw unauthorized();
  if (u.passwordHash && !(b.current && (await Bun.password.verify(b.current, u.passwordHash)))) throw unauthorized("your current password is wrong", "invalid_credentials");
  u.passwordHash = await Bun.password.hash(b.password); await u.save();
  await Session.deleteMany({ user: u._id }); // sign out everywhere, including this device
  res.clearCookie(COOKIE, { ...cookieOpts, maxAge: undefined }); res.json({ ok: true });
});
authRoutes.get("/sessions", requireAuth, async (req, res) => {
  const mine = req.cookies?.[COOKIE] ? sha256(req.cookies[COOKIE] as string) : "";
  const ss = await Session.find({ user: req.userId }).sort({ _id: -1 }).limit(20);
  res.json({ items: ss.map((x) => ({ id: x._id, userAgent: x.userAgent, createdAt: (x as unknown as { createdAt?: Date }).createdAt, current: x.tokenHash === mine })) });
});
authRoutes.delete("/sessions/:id", requireAuth, async (req, res) => { await Session.deleteOne({ _id: oid(req.params.id, "session"), user: req.userId }); res.json({ ok: true }); });

// refresh tokens rotate on every use. a replayed token finds nothing and is rejected.
authRoutes.post("/refresh", async (req, res) => {
  const old = req.cookies?.[COOKIE] as string | undefined;
  const s = old && (await Session.findOneAndDelete({ tokenHash: sha256(old), expiresAt: { $gt: new Date() } }));
  const user = s && (await User.findById(s.user));
  if (!user) { res.clearCookie(COOKIE, { ...cookieOpts, maxAge: undefined }); throw unauthorized("session expired", "session_expired"); }
  await startSession(req, res, user);
});
authRoutes.post("/logout", async (req, res) => {
  const t = req.cookies?.[COOKIE] as string | undefined;
  if (t) await Session.deleteOne({ tokenHash: sha256(t) });
  res.clearCookie(COOKIE, { ...cookieOpts, maxAge: undefined });
  res.json({ ok: true });
});
