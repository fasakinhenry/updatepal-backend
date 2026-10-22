import { Schema, model } from "mongoose";
import { env } from "./env";

const Setting = model("Setting", new Schema({ key: { type: String, unique: true, required: true }, value: Schema.Types.Mixed }, { timestamps: true }));
/** platform wide switches the admin can change at runtime. */
export const defaults = {
  registrationOpen: true, aiEnabled: true, maintenance: false, announcement: "", tippingEnabled: true,
  platformFeeBps: env.PLATFORM_FEE_BPS, minTipKobo: 10_000, minWithdrawalKobo: 100_000, minTipPaypalMinor: 100, minWithdrawalPaypalMinor: 1_000,
};
export type Settings = typeof defaults;
let cache: { at: number; v: Settings } | null = null;
export async function settings(): Promise<Settings> {
  if (cache && Date.now() - cache.at < 10_000) return cache.v;
  const v: Record<string, unknown> = { ...defaults };
  try { for (const r of await Setting.find()) if (r.key in defaults) v[r.key] = r.value; }
  catch (e) { console.error("could not load settings, using the last known values", e instanceof Error ? e.message : e); return cache?.v ?? defaults; } // never take the whole api down because settings are unreachable
  cache = { at: Date.now(), v: v as Settings };
  return cache.v;
}
export async function setSetting<K extends keyof Settings>(key: K, value: Settings[K]) { await Setting.updateOne({ key }, { value }, { upsert: true }); cache = null; }
