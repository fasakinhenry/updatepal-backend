# updatebase backend

node api for updatebase: express 5, typescript, mongodb (mongoose), run with bun. a standalone repo, separate from the frontend. vertical slices live in `src/modules/<name>` (models, routes and logic together), shared code in `src/core`.

## run locally
```bash
bun install
cp .env.example .env     # set MONGODB_URI and JWT_SECRET at minimum
bun run dev              # http://localhost:4000/api/health
bun run typecheck
bun test                 # unit tests, no database or network needed
```

## deploy
1. mongodb: create a cluster (atlas free tier works) and use its connection string as `MONGODB_URI`.
2. storage: render's disk is ephemeral, so use the default `STORAGE_PROVIDER=b2` with a private Backblaze B2 bucket, or choose `s3`, `r2`, or `custom` for another S3-compatible provider. local disk is for development only.
3. host (render, railway, fly): build `bun install`, start `bun run start`, health check `/api/health`. `render.yaml` is included. serve it over https.
4. set the environment variables below. `CLIENT_ORIGIN` must be your exact frontend origin, and `API_PUBLIC_URL` this api's public base url (used for uploaded image links).
5. register webhooks (see payments) and, for google sign in, add your frontend origin to the oauth client.

## environment
required: `MONGODB_URI`, `JWT_SECRET` (32+ random chars), `CLIENT_ORIGIN`.
- email: `RESEND_API_KEY`, `MAIL_FROM`. without a key, links are printed to the log in development only.
- google sign in: `GOOGLE_CLIENT_ID`.
- ai: `AI_PROVIDER` (`gemini`, `anthropic` or `none`), `GEMINI_API_KEY` or `ANTHROPIC_API_KEY`, optional `AI_MODEL`.
- admin: `ADMIN_EMAIL`, the only (verified) account that can open `/admin`.
- payments: `PAYMENT_PROVIDERS` (comma list of `bachs`, `paypal`), `BACHS_API_KEY`, `BACHS_WEBHOOK_SECRET`, `PAYMENT_CURRENCY`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_ENV`, `PAYPAL_WEBHOOK_ID`, `PAYPAL_CURRENCY`, `PAYPAL_PAYOUTS`, `PLATFORM_FEE_BPS`, `DATA_ENCRYPTION_KEY` (`openssl rand -base64 32`, encrypts payout details).
- files: `STORAGE_PROVIDER` (`b2` by default, `s3`, `r2`, `custom`, or explicit `local` for development), `S3_*`, `STORAGE_DIR`, `MAX_UPLOAD_MB`, `API_PUBLIC_URL`. `b2` derives `https://s3.<S3_REGION>.backblazeb2.com` when `S3_ENDPOINT` is omitted; `r2` and `custom` require `S3_ENDPOINT`.
see `.env.example` for every value.

## api
all under `/api`. errors are `{ error: { code, message, details? } }`.
| area | endpoints |
|---|---|
| auth | `POST /auth/register, login, verify-email, resend-verification, forgot-password, reset-password, google, refresh, logout, change-password`, `GET/DELETE /auth/sessions` |
| users | `GET/PATCH/DELETE /users/me`, `GET /users/me/follows, me/export`, `GET /users/by-username/:u[/connections]`, `PUT/DELETE /users/follows` |
| orgs | `POST /orgs`, `GET /orgs/mine`, `GET /orgs/by-handle/:h`, `POST /orgs/by-handle/:h/feedback`, `GET/PATCH/DELETE /orgs/:orgId`, `POST /orgs/:orgId/transfer`, members (role, extra grants, assigned channels), invitations, `POST /invitations/accept, decline` |
| feed | `GET /feed`, `GET /updates/:id`, love, bookmark, comments with replies and `@mentions`, `GET /bookmarks` |
| stories | `GET/POST /stories`, `DELETE /stories/:id`, celebrate, bookmark |
| search | `GET /search`, `GET /discover` |
| messages | encryption keys (`/keys/...`), `GET/POST /conversations`, messages, read, `PUT/DELETE /blocks/:userId`, `POST /reports` |
| publishing | `POST /orgs/:orgId/format`, drafts (edit, review, schedule), `POST .../drafts/:id/publish` |
| insights | `/orgs/:orgId/overview, analytics, analytics.csv, calendar, feedback` |
| documents | `/orgs/:orgId/documents` (folders, private upload and download) |
| media | `PUT /media?kind=...` (images only), `GET /media/:id` |
| payments | `GET /payments/tips/quote`, `POST /payments/tips`, `POST /payments/tips/batch`, `POST /payments/tips/plan`, `POST /payments/paypal/capture`, `GET /payments/wallet`, `POST /payments/wallet/withdrawals`, webhooks |
| realtime | `GET /events` (server sent events for notification and message pings) |
| ai | `POST /ai/profile/next, profile/bio, org/bio` |
| notifications | `GET /notifications[?org=:id]`, `POST /notifications/read` |
| config | `GET /config` (public: banner, maintenance, available payment methods) |
| admin | `/admin/*`, admin only |

access tokens last 15 minutes. the refresh token is an httpOnly cookie, rotated on every use, with only its hash stored. clients call `POST /auth/refresh` on `session_expired`.

## security decisions
- argon2id passwords. register, login and forgot password do not reveal whether an email exists. google accounts link only on a google verified email, and an unverified local account loses its password when linked.
- permissions are checked on the server by capability, scoped to the organization in the url. roles give a base set, owners can grant extra capabilities and limit members to assigned channels. a role in one organization grants nothing in another.
- update numbers come from an atomic counter at publish time. publishing is always an explicit action and uses an atomic claim, so a double click or the scheduler cannot publish twice.
- invitations store only a token hash, expire, and email invitations need a matching verified email. opening a link never joins by itself.
- uploads are untrusted: images are checked by their first bytes (png, jpeg, webp, gif, never svg) and served with `nosniff`. documents are private and only served through authorized routes as downloads, with random storage keys.
- the object-storage bucket must remain private. Files are read through authorized backend routes; do not enable public bucket access or public object ACLs.
- profile privacy (public, followers, people who share an organization, only me) is enforced here, and suspended users and organizations disappear from search and feeds.
- helmet, cors limited to `CLIENT_ORIGIN`, rate limits on auth, ai, uploads and admin, body size limits, zod validation on every body, and a fail-fast database connection.

## ai
providers are interchangeable (`src/core/ai.ts`). features: update formatting with each organization's rules, tone, categories and recent published updates as style examples; the onboarding profile conversation; organization bios; search keywords; and the tip planner. every feature has a rule based fallback, and admins can switch ai off at runtime.
- gemini's free tier may use prompts to improve google products. only pasted announcements, onboarding answers, search words and tipping candidates are sent, never drafts, documents or messages.
- pasted text is wrapped as data with an instruction to ignore commands inside it. money, emails and phone numbers are checked after formatting and flagged if missing. numbering, links, footer and attribution are added by code. only call metadata is logged (feature, provider, model, time, success).
- the tip planner can only choose from updates the person already bookmarked, loved or referenced in a story. the server validates the ids, the minimum and the budget, and nothing is charged until the person approves and pays.

## payments
two providers, selected per tip by the person (and pre-selected from their profile):
- **bachs** (`PAYMENT_CURRENCY`, default NGN): hosted checkout, credited after a signed `collection.succeeded` webhook (`/api/payments/webhook`, hmac sha256 of `{timestamp}.{raw body}`, 5 minute window). use a `sk_sandbox_` key first.
- **paypal** (`PAYPAL_CURRENCY`, default USD, since paypal does not support NGN): orders v2. the buyer approves on paypal, returns to `/app/wallet`, and the server captures the order. the webhook `/api/payments/paypal/webhook` (event `PAYMENT.CAPTURE.COMPLETED`, verified through paypal's verify-webhook-signature api with `PAYPAL_WEBHOOK_ID`) is the backup path. one paypal checkout can carry several tips (used by the ai tip planner).
- amounts are checked against our own record, events are de-duplicated, and money is stored as integer minor units, per currency. the platform fee (admin setting) comes out of the tip, then the organization's tip mode splits it. wallet balances change atomically with an append only ledger, and the admin page reconciles them.
- withdrawals hold the amount immediately. bank details and paypal emails are encrypted at rest. an admin pays by hand and enters the payout reference, or pays paypal withdrawals through the payouts api when `PAYPAL_PAYOUTS=true` (needs payouts enabled on your paypal account).
- if you ran an earlier version, drop the old `wallets` index `kind_1_owner_1` so the new per-currency index can build.
- only unit checks and signature logic were tested here. run full sandbox payments for both providers before going live.

## end to end encrypted messages
clients use web crypto only (ecdh p-256, hkdf, aes-256-gcm). the server stores public keys, a passcode wrapped backup of each private key (pbkdf2, 600k iterations) and ciphertext, so it cannot read messages. it can see who talks to whom and when. messages are bound to their conversation and record the public keys they used. people can compare a safety number. limits: this is not the signal protocol, there is no forward secrecy or key transparency, and forgetting the passcode makes old messages unrecoverable. get it reviewed before relying on it for sensitive conversations.

## admin area
only a verified account with `ADMIN_EMAIL` can use `/api/admin/*` (others get a 404). it covers platform and activity analytics, user and organization management, moderation (reports, hide and restore content), payments and withdrawals, ai usage, system status, runtime controls (sign ups, ai, tipping, maintenance mode, banner, fees and minimums) and an audit log. messages show counts only.

## realtime, scheduling and storage
- realtime uses server sent events held in memory, so it works for one server instance. for several instances, add a pub/sub layer. clients also poll slowly as a backup.
- scheduled drafts are published by an in-process job that runs every minute. on a host that sleeps, posts publish late. run an always-on instance for exact timing.
- files go through the storage port: local disk for development, s3 compatible for production.

## known limitations
no direct publishing to social channels (copy and paste is the workflow), no encrypted attachments or voice notes, no story comments or editing, no video, a single in-memory realtime hub, local-only search (regex, fine for small data), and automated tests cover pure logic only. nothing has been run against a real database, the payment sandboxes or an s3 bucket yet.

## git
```bash
git init && git add . && git commit -m "feat(api): add updatebase backend"
git branch -M main && git remote add origin <your-repo-url> && git push -u origin main
```
