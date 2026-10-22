import type { Response } from "express";

// server sent events for live notification and message pings. state is in memory, so this works for a single server instance.
// for several instances, fan out through redis pub/sub or similar. clients also poll slowly as a fallback.
const subs = new Map<string, Set<Response>>();
export function subscribe(userId: string, res: Response) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.write("retry: 5000\n\n");
  const set = subs.get(userId) ?? new Set<Response>(); set.add(res); subs.set(userId, set);
  const beat = setInterval(() => res.write(": ping\n\n"), 25_000);
  res.on("close", () => { clearInterval(beat); set.delete(res); if (!set.size) subs.delete(userId); });
}
export function push(userId: unknown, event: string, data: unknown = {}) {
  for (const res of subs.get(String(userId)) ?? []) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
