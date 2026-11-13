// Prüft Eingaben, bevor der Server fremde Seiten abruft. Ohne diese Prüfung
// könnte jemand den Server als Werkzeug benutzen, um interne Adressen
// abzufragen oder riesige Dateien zu laden. Vorlage: GTM OS, src/guard.ts.

import { normalizeDomain } from "../public/lib/list.js";

export { normalizeDomain };

const MAX_BYTES = 300_000;
const MAX_REDIRECTS = 3;
export const USER_AGENT = "Mozilla/5.0 (compatible; lead-table-demo/1.0; +https://lead-table.lucaputaro.workers.dev)";

export function clip(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max).trim() : "";
}

export type Page = { ok: true; html: string; finalHost: string } | { ok: false; reason: string };

// Nur https, keine eigene Portnummer, und der Host muss dieselbe Prüfung
// bestehen wie eine Eingabe. Gilt für die erste Adresse und jede Weiterleitung.
export function safeUrl(location: string | null, base?: string): string | null {
  if (!location) return null;
  try {
    const next = new URL(location, base);
    if (next.protocol !== "https:" || next.port !== "") return null;
    return normalizeDomain(next.hostname) ? next.href : null;
  } catch {
    return null;
  }
}

function fetchOnce(url: string, signal: AbortSignal): Promise<Response> {
  return fetch(url, {
    // Weiterleitungen selbst verfolgen: sonst könnte eine geprüfte Seite auf
    // eine Adresse umleiten, die die Eingabeprüfung abgelehnt hätte
    // (z. B. *.workers.dev). Vorlage: GTM OS, Commit 8baf11c.
    redirect: "manual",
    signal,
    headers: { "user-agent": USER_AGENT, accept: "text/html", "accept-language": "en,de;q=0.8" },
  });
}

export async function fetchPage(start: string, timeoutMs = 7000): Promise<Page> {
  const first = safeUrl(start);
  if (!first) return { ok: false, reason: "address is not allowed" };
  let url: string = first;
  let res: Response;
  try {
    const signal = AbortSignal.timeout(timeoutMs);
    res = await fetchOnce(url, signal);
    for (let hop = 0; res.status >= 300 && res.status < 400; hop++) {
      const next: string | null = hop < MAX_REDIRECTS ? safeUrl(res.headers.get("location"), url) : null;
      await res.body?.cancel().catch(() => undefined);
      if (!next) return { ok: false, reason: hop < MAX_REDIRECTS ? "redirects to an address that is not allowed" : "redirects too often" };
      url = next;
      res = await fetchOnce(url, signal);
    }
  } catch (err) {
    const timeout = err instanceof Error && /timeout|abort/i.test(err.name + err.message);
    return { ok: false, reason: timeout ? "no answer within 7 seconds" : "could not connect" };
  }
  if (!res.ok || !res.body) {
    await res.body?.cancel().catch(() => undefined);
    return { ok: false, reason: res.status === 403 || res.status === 429 ? `blocks automated visitors (${res.status})` : `answered ${res.status}` };
  }
  if (!(res.headers.get("content-type") ?? "").includes("html")) {
    await res.body.cancel().catch(() => undefined);
    return { ok: false, reason: "did not answer with a web page" };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let html = "";
  let bytes = 0;
  while (bytes < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    html += decoder.decode(value, { stream: true });
  }
  await reader.cancel().catch(() => undefined);
  // url ist die zuletzt geprüfte Adresse, also das tatsächliche Ziel.
  return { ok: true, html, finalHost: new URL(url).hostname.replace(/^www\./, "") };
}
