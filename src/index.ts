// Einstiegspunkt. Zwei Schnittstellen: /api/enrich reichert eine Zeile an,
// /api/hook schreibt den Aufhänger-Satz. Der Browser ruft sie Zeile für
// Zeile auf, so füllt sich die Tabelle sichtbar und keine Anfrage dauert
// lange. Gespeichert wird nichts.

import { clip, normalizeDomain } from "./guard";
import { enrich } from "./enrich";
import { writeHook, type AiEnv } from "./ai";

interface Env extends AiEnv {
  ASSETS: Fetcher;
  LIMITER?: RateLimit;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    if (request.method !== "POST") return json({ error: "Use POST." }, 405);

    const origin = request.headers.get("origin");
    if (origin && new URL(origin).host !== url.host) return json({ error: "Cross-site requests are not allowed." }, 403);

    if (env.LIMITER) {
      const key = request.headers.get("cf-connecting-ip") ?? "unknown";
      const { success } = await env.LIMITER.limit({ key });
      if (!success) return json({ error: "Too many requests. Waiting a moment before the next row." }, 429);
    }

    let body: Record<string, unknown>;
    try {
      const raw = await request.text();
      if (raw.length > 4000) return json({ error: "Request is too large." }, 413);
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return json({ error: "Body must be JSON." }, 400);
    }

    switch (url.pathname) {
      case "/api/enrich": {
        const domain = normalizeDomain(clip(body.domain, 200));
        if (!domain) return json({ error: "That does not look like a website." }, 400);
        return json(await enrich(domain));
      }
      case "/api/hook": {
        const facts = {
          company: clip(body.company, 80),
          domain: normalizeDomain(clip(body.domain, 200)) ?? "",
          about: clip(body.about, 300),
          motion: clip(body.motion, 20),
          motionEvidence: clip(body.motionEvidence, 120),
          crm: clip(body.crm, 80),
          mail: clip(body.mail, 60),
          employees: typeof body.employees === "number" && Number.isFinite(body.employees) ? Math.round(body.employees) : null,
        };
        if (!facts.domain) return json({ error: "That does not look like a website." }, 400);
        return json(await writeHook(env, facts));
      }
      default:
        return json({ error: "Unknown endpoint." }, 404);
    }
  },
} satisfies ExportedHandler<Env>;
