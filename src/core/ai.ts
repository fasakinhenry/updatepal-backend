import Anthropic from "@anthropic-ai/sdk";
import type { ZodType } from "zod";
import { env } from "./env";
import { settings } from "./settings";
import { AiLog } from "@/modules/system/models";

// providers are interchangeable. to add one, implement AiProvider and register it below.
export interface AiProvider { name: string; model: string; generate(system: string, user: string, maxTokens: number): Promise<string> }

const gemini = (key: string, model: string): AiProvider => ({
  name: "gemini", model,
  async generate(system, user, maxTokens) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": key }, signal: AbortSignal.timeout(25_000),
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] }, contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: { maxOutputTokens: Math.max(maxTokens, 1024), temperature: 0.3, responseMimeType: "application/json", ...(/2\.5-flash/.test(model) ? { thinkingConfig: { thinkingBudget: 0 } } : {}) },
      }),
    });
    if (!r.ok) throw new Error(`gemini ${r.status}`);
    const j = (await r.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    return (j.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("");
  },
});
const anthropic = (key: string, model: string): AiProvider => {
  const c = new Anthropic({ apiKey: key, timeout: 25_000, maxRetries: 1 });
  return { name: "anthropic", model, async generate(system, user, maxTokens) { const r = await c.messages.create({ model, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] }); return r.content.map((b) => (b.type === "text" ? b.text : "")).join(""); } };
};
function build(): AiProvider | null {
  if (env.AI_PROVIDER === "gemini" && env.GEMINI_API_KEY) return gemini(env.GEMINI_API_KEY, env.AI_MODEL ?? "gemini-2.5-flash");
  if (env.AI_PROVIDER === "anthropic" && env.ANTHROPIC_API_KEY) return anthropic(env.ANTHROPIC_API_KEY, env.AI_MODEL ?? "claude-haiku-5-5");
  return null;
}
const provider = build();
export const aiStatus = () => ({ provider: env.AI_PROVIDER, model: provider?.model ?? null, configured: !!provider });
export const aiEnabled = !!provider;

/** asks the model for json and validates it. returns null on any failure so callers fall back to rules. */
export async function askJson<T>(kind: string, system: string, user: string, schema: ZodType<T>, maxTokens = 1200): Promise<T | null> {
  if (!provider || !(await settings()).aiEnabled) return null;
  const t0 = Date.now(); let ok = false;
  try {
    const text = await provider.generate(system, user, maxTokens);
    const parsed = schema.safeParse(JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)));
    ok = parsed.success;
    return parsed.success ? parsed.data : null;
  } catch (e) { console.error("ai call failed:", e instanceof Error ? e.message : e); return null; }
  finally { void AiLog.create({ kind, provider: provider.name, model: provider.model, ok, ms: Date.now() - t0 }).catch(() => undefined); } // metadata only, never content
}
/** user supplied text is wrapped as data. the system prompt tells the model never to obey it. */
export const asData = (tag: string, text: string) => `<${tag}>\n${text.replaceAll(`</${tag}>`, "")}\n</${tag}>`;
