import { createHmac, randomBytes } from "node:crypto";
import { beforeAll, describe, expect, test } from "bun:test";

// these tests cover pure logic and need no database or network
process.env.MONGODB_URI = "mongodb://127.0.0.1:1/test"; process.env.JWT_SECRET = "t".repeat(40); process.env.NODE_ENV = "test";
process.env.PAYMENT_PROVIDERS = "bachs"; process.env.BACHS_API_KEY = "sk_sandbox_test"; process.env.BACHS_WEBHOOK_SECRET = "whsec_test";
process.env.DATA_ENCRYPTION_KEY = randomBytes(32).toString("base64"); process.env.ADMIN_EMAIL = "Boss@Example.com";

let fmt: typeof import("@/modules/publishing/formatter"), ledger: typeof import("@/modules/payments/ledger"), prov: typeof import("@/modules/payments/provider");
let crypt: typeof import("@/core/crypto"), caps: typeof import("@/core/caps"), env: typeof import("@/core/env"), plan: typeof import("@/modules/payments/plan");
beforeAll(async () => { fmt = await import("@/modules/publishing/formatter"); ledger = await import("@/modules/payments/ledger"); prov = await import("@/modules/payments/provider"); crypt = await import("@/core/crypto"); caps = await import("@/core/caps"); env = await import("@/core/env"); plan = await import("@/modules/payments/plan"); });

const rules = { lowercase: true, numbering: true, prefix: "✅", footer: "from FUTA Techies", link: "https://bit.ly/futatechies2", attribution: true, handle: "HENQSOFT", categories: ["🎓 scholarship update", "💼 internship update", "📢 community update"] };

describe("formatter", () => {
  test("applies the organization's rules and keeps facts", () => {
    const r = fmt.formatDeterministic("Chevening Scholarship 2027\nFully funded masters in the UK. Stipend ₦250,000.\nDeadline: 5 November\nApply at https://www.chevening.org", rules, "whatsapp", 153);
    expect(r.category).toBe("🎓 scholarship update");
    expect(r.text).toContain("*chevening scholarship 2027*");
    expect(r.text).toContain("⏰ deadline: 5 November");
    expect(r.text).toContain("https://www.chevening.org");
    expect(r.text).toContain("✅ 153");
    expect(r.text.endsWith("HENQSOFT from FUTA Techies")).toBe(true); // the footer keeps its own casing
    expect(r.warnings).toEqual([]);
  });
  test("flags missing facts instead of inventing them", () => {
    const r = fmt.formatDeterministic("Community meetup\nCome along", rules, "updatebase", 1);
    expect(r.warnings.some((w) => w.includes("deadline"))).toBe(true);
    expect(r.warnings.some((w) => w.includes("link"))).toBe(true);
  });
  test("detects money that disappeared", () => {
    expect(fmt.checkFacts("Pay ₦250,000 contact jobs@acme.test", "nothing here").length).toBe(2);
    expect(fmt.checkFacts("Pay ₦250,000", "pay ₦250,000 monthly")).toEqual([]);
  });
  test("warns when a channel limit is exceeded", () => {
    const r = fmt.formatDeterministic(`Big announcement\n${"word ".repeat(100)}`, rules, "x", null);
    expect(r.warnings.some((w) => w.includes("limit"))).toBe(true);
  });
});

describe("tip split", () => {
  test("fee comes out first, then the shared split", () => {
    expect(ledger.computeSplit(50_000, 100, "shared", 70, true)).toEqual({ fee: 500, org: 34_650, poster: 14_850 });
    expect(ledger.computeSplit(50_000, 100, "org", 70, true)).toEqual({ fee: 500, org: 49_500, poster: 0 });
    expect(ledger.computeSplit(10_001, 250, "shared", 70, false).poster).toBe(0);
  });
  test("parts always add up to the tip", () => { for (const a of [1, 99, 12_345, 999_999]) { const s = ledger.computeSplit(a, 333, "shared", 61, true); expect(s.fee + s.org + s.poster).toBe(a); } });
});

describe("payment webhooks", () => {
  const body = Buffer.from(JSON.stringify({ id: "evt_1", type: "collection.succeeded", data: { checkout_id: "c1", amount: "500.00", currency: "NGN" } }));
  const sign = (ts: number, secret = "whsec_test") => createHmac("sha256", secret).update(`${ts}.${body.toString()}`).digest("hex");
  const now = () => Math.floor(Date.now() / 1000);
  test("accepts a valid signature", async () => { const t = now(); expect((await prov.providers.bachs!.verifyWebhook(body, { "x-bachs-signature-v2": `t=${t},v1=${sign(t)}` }))?.type).toBe("collection.succeeded"); });
  test("rejects a wrong secret, a tampered body and a stale timestamp", async () => {
    const t = now(); const p = prov.providers.bachs!;
    expect(await p.verifyWebhook(body, { "x-bachs-signature-v2": `t=${t},v1=${sign(t, "other")}` })).toBeNull();
    expect(await p.verifyWebhook(Buffer.from(body.toString().replace("500", "5")), { "x-bachs-signature-v2": `t=${t},v1=${sign(t)}` })).toBeNull();
    expect(await p.verifyWebhook(body, { "x-bachs-signature-v2": `t=${t - 1000},v1=${sign(t - 1000)}` })).toBeNull();
  });
});

describe("security helpers", () => {
  test("field encryption round trips and hides the value", () => { const e = crypt.encryptField("0123456789"); expect(crypt.decryptField(e)).toBe("0123456789"); expect(e).not.toContain("0123456789"); });
  test("admin email matching ignores case", () => { expect(env.isAdminEmail("boss@example.com")).toBe(true); expect(env.isAdminEmail("other@example.com")).toBe(false); expect(env.isAdminEmail(undefined)).toBe(false); });
  test("capabilities come from the role plus individual grants", () => {
    expect(caps.can("delegate", "publish")).toBe(true); expect(caps.can("delegate", "documents")).toBe(false);
    expect(caps.can("delegate", "documents", ["documents"])).toBe(true); expect(caps.can(undefined, "publish", ["publish"])).toBe(false);
  });
});

describe("ai tip plan", () => {
  const cands = [{ id: "a", title: "A", org: "o", cat: "", why: ["bookmarked", "loved"] }, { id: "b", title: "B", org: "o", cat: "", why: ["loved"] }, { id: "c", title: "C", org: "o", cat: "", why: [] }];
  test("without ai it splits the budget and never exceeds it", async () => {
    const p = await plan.planTips("", 1000, 100, cands);
    expect(p.aiUsed).toBe(false); expect(p.items.length).toBeGreaterThan(0);
    expect(p.items.reduce((a, i) => a + i.amountMinor, 0)).toBeLessThanOrEqual(1000);
    expect(p.items.every((i) => i.amountMinor >= 100 && cands.some((c) => c.id === i.id))).toBe(true);
  });
  test("an empty candidate list gives an empty plan", async () => { expect((await plan.planTips("", 1000, 100, [])).items).toEqual([]); });
});
