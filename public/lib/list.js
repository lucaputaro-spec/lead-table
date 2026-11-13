// Liste einlesen und aufräumen. Läuft im Browser und im Worker (der Worker
// importiert normalizeDomain von hier), damit beide Seiten dieselbe Regel
// benutzen, was als gültige Website gilt.

export const MAX_ROWS = 25;

/**
 * @param {string} input
 * @returns {string | null}
 */
export function normalizeDomain(input) {
  let s = String(input).trim().toLowerCase();
  if (s.includes("@")) s = s.slice(s.lastIndexOf("@") + 1);
  s = s.replace(/^[a-z]+:\/\//, "").replace(/^www\./, "");
  s = s.split(/[/?#\s]/)[0] ?? "";
  s = s.replace(/\.$/, "");
  if (s.length > 100 || s.includes(":")) return null;
  if (!/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/.test(s)) return null;
  if (/\.(local|internal|localhost|test|invalid|example|arpa)$/.test(s)) return null;
  if (s.endsWith("workers.dev")) return null;
  return s;
}

/**
 * @typedef {{ n: number, input: string, domain: string | null, duplicateOf: number | null }} ListRow
 */

/**
 * Eine Zeile je Eintrag. Leere Zeilen fallen weg, Kommas und Semikolons
 * trennen ebenfalls (so lässt sich auch eine CSV-Spalte einfügen).
 * @param {string} text
 * @returns {{ rows: ListRow[], dropped: number }}
 */
export function parseList(text) {
  const items = String(text)
    .split(/[\n,;\t]+/)
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
  /** @type {Map<string, number>} */
  const seen = new Map();
  /** @type {ListRow[]} */
  const rows = [];
  for (const input of items.slice(0, MAX_ROWS)) {
    const n = rows.length + 1;
    const domain = normalizeDomain(input);
    const first = domain ? seen.get(domain) : undefined;
    if (domain && first === undefined) seen.set(domain, n);
    rows.push({ n, input: input.slice(0, 200), domain, duplicateOf: first ?? null });
  }
  return { rows, dropped: Math.max(0, items.length - MAX_ROWS) };
}

/**
 * Zweite Dublettenprüfung nach der Anreicherung: zwei verschiedene Eingaben
 * können dieselbe Firma sein (notion.so leitet auf notion.com um, oder beide
 * zeigen auf denselben Wikidata-Eintrag). Behalten wird die Zeile, deren
 * Domain das tatsächliche Ziel ist, sonst die erste. Liefert je doppelter
 * Zeilennummer die Nummer der behaltenen Zeile und den Grund.
 * @param {{ n: number, domain?: string | null, finalHost: string | null, wikidataId: string | null }[]} rows
 * @returns {Map<number, { of: number, why: string }>}
 */
export function findLateDuplicates(rows) {
  const sorted = [...rows].sort((a, b) => a.n - b.n);
  /** @type {Map<string, typeof sorted>} */
  const groups = new Map();
  for (const r of sorted) {
    const host = r.finalHost ? r.finalHost.replace(/^www\./, "") : null;
    // Gleicher Wikidata-Eintrag oder gleiches Ziel: dieselbe Gruppe.
    const keys = [host && `host:${host}`, r.wikidataId && `wiki:${r.wikidataId}`].filter(Boolean);
    const existing = keys.map((k) => groups.get(/** @type {string} */ (k))).find(Boolean);
    const group = existing ?? [];
    if (!existing) group.push(r);
    else if (!group.includes(r)) group.push(r);
    for (const k of keys) groups.set(/** @type {string} */ (k), group);
  }
  /** @type {Map<number, { of: number, why: string }>} */
  const out = new Map();
  for (const group of new Set(groups.values())) {
    if (group.length < 2) continue;
    const keeper = group.find((r) => r.domain && r.finalHost && r.finalHost.replace(/^www\./, "") === r.domain) ?? group[0];
    if (!keeper) continue;
    for (const r of group) {
      if (r === keeper) continue;
      const sameHost = r.finalHost && keeper.finalHost && r.finalHost.replace(/^www\./, "") === keeper.finalHost.replace(/^www\./, "");
      const why = sameHost ? `both end up on ${keeper.finalHost?.replace(/^www\./, "")}` : `same Wikidata entry ${r.wikidataId}`;
      out.set(r.n, { of: keeper.n, why });
    }
  }
  return out;
}
