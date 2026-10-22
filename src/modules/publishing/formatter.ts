// rule based formatter and the shared assembly step. the ai formatter supplies fields, this code assembles
// the final text so numbering, links, footer and attribution are always applied exactly as configured.
export type Rules = { lowercase?: boolean; numbering?: boolean; prefix?: string; footer?: string; link?: string; attribution?: boolean; handle?: string; instructions?: string; tone?: string; categories?: string[]; maxLength?: number; useExamples?: boolean };
export type Formatted = { text: string; warnings: string[]; category: string; aiUsed: boolean; usedExamples: number };
export const channelMax: Record<string, number> = { updatebase: 3000, whatsapp: 4096, facebook: 5000, instagram: 2200, linkedin: 3000, x: 280 };

const generic = ["scholarship update", "job update", "internship update", "competition update", "event update", "community update"];
export const categoriesOf = (r: Rules) => (r.categories?.length ? r.categories : generic);
const keys: [string, RegExp][] = [["scholarship", /scholar|fellowship|grant|bursary/i], ["hackathon", /hackathon|competition|challenge/i], ["competition", /competition|contest|challenge/i], ["internship", /intern/i], ["job", /job|hiring|vacanc|engineer|developer/i], ["tech", /software|developer|engineer|ai|data/i], ["event", /event|webinar|summit|conference/i]];
export function guessCategory(src: string, r: Rules): string {
  const cats = categoriesOf(r);
  for (const [k, re] of keys) if (re.test(src)) { const hit = cats.find((c) => c.toLowerCase().includes(k)); if (hit) return hit; }
  return cats.find((c) => /community|general|other/i.test(c)) ?? cats[cats.length - 1];
}
export function parseSource(source: string) {
  const clean = source.replace(/\r/g, "").trim();
  const urls = [...new Set(clean.match(/https?:\/\/\S+/g) ?? [])];
  const lines = clean.replace(/https?:\/\/\S+/g, "").split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const deadline = clean.match(/(?:deadline|closes?|apply (?:by|before))[:\s-]+([^\n.]+)/i)?.[1]?.trim();
  return { clean, urls, lines, deadline };
}
export type Fields = { category: string; title: string; summary: string; deadline?: string | null };

export function assemble(f: Fields, urls: string[], r: Rules, channel: string, number: number | null, hint: string): { text: string; warnings: string[] } {
  const dl = f.deadline ? `⏰ deadline: ${f.deadline}` : "";
  const dlFirst = /deadline/i.test(hint);
  const title = channel === "whatsapp" ? `*${f.title}*` : f.title;
  const top = [f.category, dlFirst ? dl : "", title, f.summary].filter(Boolean).join("\n\n");
  const tail = [dlFirst ? "" : dl, ...urls.map((u) => `🔗 ${u}`), r.link ? `join the community: ${r.link}` : "", r.numbering && number !== null ? `${r.prefix ?? ""} ${number}`.trim() : "", [r.attribution ? r.handle : "", r.footer].filter(Boolean).join(" ")].filter(Boolean).join("\n");
  const text = `${r.lowercase ? top.toLowerCase() : top}\n\n${tail}`;
  const max = Math.min(channelMax[channel] ?? 3000, r.maxLength && channel === "updatebase" ? 3000 : channelMax[channel] ?? 3000);
  const warnings = [!f.deadline && "no deadline found in the source. check it before posting.", !urls.length && "no registration link found in the source.", text.length > max && `over the ${channel} limit of ${max} characters. shorten it before posting.`].filter(Boolean) as string[];
  return { text, warnings };
}
/** facts that must survive formatting: money, emails and phone numbers. returns warnings for any that vanished. */
export function checkFacts(source: string, text: string): string[] {
  const toks = source.match(/[\w.+-]+@[\w-]+\.[\w.]+|\+?\d[\d\s-]{7,}\d|[$₦£€]\s?\d[\d,.]*\w*/g) ?? [];
  const squash = (s: string) => s.toLowerCase().replace(/\s/g, "");
  return [...new Set(toks)].filter((t) => !squash(text).includes(squash(t))).slice(0, 4).map((t) => `check that "${t.trim()}" from the source is still included`);
}

export function formatDeterministic(source: string, rules: Rules, channel: string, number: number | null, hint = ""): Formatted {
  const p = parseSource(source);
  const category = guessCategory(p.clean, rules);
  if (!p.clean) return { text: "", warnings: ["the source is empty"], category, aiUsed: false, usedExamples: 0 };
  // the deadline and links are re-added in the footer, so drop lines that only carry them
  const body = p.lines.slice(1).filter((l) => !/^(deadline|closes?)[:\s-]/i.test(l) && !/(apply|register|link|visit)( at| here| via| on| through)?:?$/i.test(l));
  const summary = (/short/i.test(hint) ? body.slice(0, 2) : body).join("\n");
  const { text, warnings } = assemble({ category, title: p.lines[0], summary, deadline: p.deadline }, p.urls, rules, channel, number, hint);
  return { text, warnings: [...warnings, ...checkFacts(p.clean, text)], category, aiUsed: false, usedExamples: 0 };
}
