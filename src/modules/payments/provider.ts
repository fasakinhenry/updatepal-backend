import { createHmac, timingSafeEqual } from "node:crypto";
import { ApiError } from "@/core/http";
import { env } from "@/core/env";

// payment providers are interchangeable. implement this interface to add another one.
export type Unit = { reference: string; amount: string; description?: string };
export type CheckoutInput = { reference: string; currency: string; email?: string; units: Unit[]; successUrl?: string; cancelUrl?: string; metadata?: Record<string, string> };
export type ProviderEvent = { id: string; type: string; data: Record<string, unknown> };
export type Captured = { completed: boolean; units: { customId?: string; amount: string; currency: string }[] };
export type ProviderName = "bachs" | "paypal";
export interface PaymentProvider {
  name: ProviderName;
  currency: string;
  /** true when one checkout can carry several tips */
  batch: boolean;
  createCheckout(i: CheckoutInput): Promise<{ id: string; url: string }>;
  /** returns the parsed event only if the signature is valid */
  verifyWebhook(raw: Buffer, headers: Record<string, string | string[] | undefined>): Promise<ProviderEvent | null>;
  /** for providers where the buyer approves first and we capture afterwards */
  capture?(orderId: string): Promise<Captured>;
  payout?(i: { id: string; email: string; amount: string; currency: string; note: string }): Promise<{ ref: string }>;
}

const h = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const fail = (what: string, status: number, body: unknown) => { console.error(`${what} failed`, status, JSON.stringify(body)?.slice(0, 400)); return new ApiError(502, "payment_provider_error", "the payment provider could not complete that. try again."); };

function bachs(apiKey: string, secret: string): PaymentProvider {
  // keys starting with sk_live_ use production, anything else uses the sandbox
  const base = apiKey.startsWith("sk_live_") ? "https://api.bachs.io" : "https://sandbox-api.bachs.io";
  return {
    name: "bachs", currency: env.PAYMENT_CURRENCY, batch: false,
    async createCheckout(i) {
      const body: Record<string, unknown> = { pricing: { currency: i.currency, amount: i.units[0].amount }, customer: { email: i.email }, reference: i.reference, metadata: i.metadata, expires_in_minutes: 60 };
      const local = /localhost|127\.0\.0\.1/.test(env.CLIENT_ORIGIN); // bachs refuses private addresses for return urls
      if (i.successUrl && !local) body.success_url = i.successUrl;
      if (i.cancelUrl && !local) body.cancel_url = i.cancelUrl;
      const r = await fetch(`${base}/v1/checkout-sessions`, { method: "POST", signal: AbortSignal.timeout(15_000), headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "Idempotency-Key": i.reference }, body: JSON.stringify(body) });
      const j = (await r.json().catch(() => null)) as { checkout_id?: string; checkout_url?: string } | null;
      if (!r.ok || !j?.checkout_id || !j.checkout_url) throw fail("bachs checkout", r.status, j);
      return { id: j.checkout_id, url: j.checkout_url };
    },
    async verifyWebhook(raw, headers) {
      const v2 = h(headers["x-bachs-signature-v2"]); let ts = Number(h(headers["x-bachs-timestamp"])); let sigs: string[] = [];
      if (v2) { const parts = v2.split(","); ts = Number(parts.find((p) => p.startsWith("t="))?.slice(2)); sigs = parts.filter((p) => p.startsWith("v1=")).map((p) => p.slice(3)); }
      else { const s = h(headers["x-bachs-signature"]); if (s) sigs = [s]; }
      if (!Number.isFinite(ts) || !sigs.length || Math.abs(Date.now() / 1000 - ts) > 300) return null; // stale deliveries are rejected
      const expected = createHmac("sha256", secret).update(`${ts}.`).update(raw).digest("hex"); // hmac of "{timestamp}.{raw body}"
      if (!sigs.some((s) => s.length === expected.length && timingSafeEqual(Buffer.from(s), Buffer.from(expected)))) return null;
      try { return JSON.parse(raw.toString("utf8")) as ProviderEvent; } catch { return null; }
    },
  };
}

function paypal(id: string, secret: string, webhookId: string | undefined, sandbox: boolean): PaymentProvider {
  const base = sandbox ? "https://api-m.sandbox.paypal.com" : "https://api-m.paypal.com";
  let tok: { v: string; exp: number } | null = null;
  const token = async () => {
    if (tok && tok.exp > Date.now() + 60_000) return tok.v;
    const r = await fetch(`${base}/v1/oauth2/token`, { method: "POST", signal: AbortSignal.timeout(15_000), headers: { Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" }, body: "grant_type=client_credentials" });
    const j = (await r.json().catch(() => null)) as { access_token?: string; expires_in?: number } | null;
    if (!r.ok || !j?.access_token) throw fail("paypal auth", r.status, j);
    tok = { v: j.access_token, exp: Date.now() + (j.expires_in ?? 300) * 1000 }; return tok.v;
  };
  const call = async (path: string, method: string, body?: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(`${base}${path}`, { method, signal: AbortSignal.timeout(20_000), headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { ok: r.ok, status: r.status, j: (await r.json().catch(() => null)) as Record<string, any> | null }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  const units = (o: Record<string, any> | null): Captured["units"] => // eslint-disable-line @typescript-eslint/no-explicit-any
    ((o?.purchase_units ?? []) as Record<string, any>[]).flatMap((pu) => ((pu.payments?.captures ?? []) as Record<string, any>[]).filter((c) => c.status === "COMPLETED").map((c) => ({ customId: String(c.custom_id ?? pu.custom_id ?? pu.reference_id ?? ""), amount: String(c.amount?.value), currency: String(c.amount?.currency_code) }))); // eslint-disable-line @typescript-eslint/no-explicit-any
  return {
    name: "paypal", currency: env.PAYPAL_CURRENCY, batch: true,
    async createCheckout(i) {
      const body = {
        intent: "CAPTURE",
        purchase_units: i.units.map((u) => ({ reference_id: u.reference, custom_id: u.reference, description: u.description?.slice(0, 120), amount: { currency_code: i.currency, value: u.amount } })),
        payment_source: { paypal: { experience_context: { brand_name: "updatebase", user_action: "PAY_NOW", shipping_preference: "NO_SHIPPING", return_url: i.successUrl, cancel_url: i.cancelUrl } } },
      };
      const r = await call("/v2/checkout/orders", "POST", body, { "PayPal-Request-Id": i.reference });
      const links = (r.j?.links ?? []) as { rel: string; href: string }[];
      const url = links.find((l) => l.rel === "payer-action")?.href ?? links.find((l) => l.rel === "approve")?.href;
      if (!r.ok || !r.j?.id || !url) throw fail("paypal create order", r.status, r.j);
      return { id: String(r.j.id), url };
    },
    async capture(orderId) {
      let r = await call(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, "POST", {}, { "PayPal-Request-Id": `cap_${orderId}` });
      if (r.status === 422 && JSON.stringify(r.j).includes("ORDER_ALREADY_CAPTURED")) r = await call(`/v2/checkout/orders/${encodeURIComponent(orderId)}`, "GET");
      if (!r.ok) throw fail("paypal capture", r.status, r.j);
      return { completed: r.j?.status === "COMPLETED", units: units(r.j) };
    },
    async verifyWebhook(raw, headers) {
      if (!webhookId) return null;
      let event: Record<string, any>; try { event = JSON.parse(raw.toString("utf8")); } catch { return null; } // eslint-disable-line @typescript-eslint/no-explicit-any
      const body = { auth_algo: h(headers["paypal-auth-algo"]), cert_url: h(headers["paypal-cert-url"]), transmission_id: h(headers["paypal-transmission-id"]), transmission_sig: h(headers["paypal-transmission-sig"]), transmission_time: h(headers["paypal-transmission-time"]), webhook_id: webhookId, webhook_event: event };
      if (!body.transmission_id || !body.transmission_sig) return null;
      const r = await call("/v1/notifications/verify-webhook-signature", "POST", body); // paypal checks the signature for us
      return r.ok && r.j?.verification_status === "SUCCESS" ? { id: String(event.id), type: String(event.event_type), data: (event.resource ?? {}) as Record<string, unknown> } : null;
    },
    async payout(i) {
      const r = await call("/v1/payments/payouts", "POST", { sender_batch_header: { sender_batch_id: i.id, email_subject: "you received a payout from updatebase", email_message: i.note }, items: [{ recipient_type: "EMAIL", receiver: i.email, amount: { value: i.amount, currency: i.currency }, note: i.note, sender_item_id: i.id }] }, { "PayPal-Request-Id": i.id });
      const ref = r.j?.batch_header?.payout_batch_id; if (!r.ok || !ref) throw fail("paypal payout", r.status, r.j);
      return { ref: String(ref) };
    },
  };
}

export const providers: Partial<Record<ProviderName, PaymentProvider>> = {};
const wanted = (env.PAYMENT_PROVIDERS || env.PAYMENT_PROVIDER || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
if (wanted.includes("bachs") && env.BACHS_API_KEY && env.BACHS_WEBHOOK_SECRET) providers.bachs = bachs(env.BACHS_API_KEY, env.BACHS_WEBHOOK_SECRET);
if (wanted.includes("paypal") && env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET) providers.paypal = paypal(env.PAYPAL_CLIENT_ID, env.PAYPAL_CLIENT_SECRET, env.PAYPAL_WEBHOOK_ID, env.PAYPAL_ENV === "sandbox");
export const providerList = Object.values(providers) as PaymentProvider[];
export const hasPayments = providerList.length > 0;
export const payoutsEnabled = env.PAYPAL_PAYOUTS === "true" && !!providers.paypal?.payout;
