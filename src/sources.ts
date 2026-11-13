// Abrufe bei öffentlichen Quellen. Alle gratis und ohne Schlüssel:
// DNS über HTTPS bei Cloudflare (1.1.1.1) und Google, Wikidata.

import { USER_AGENT } from "./guard";

export type Resolver = "cloudflare" | "google";

const RESOLVERS: Record<Resolver, string> = {
  cloudflare: "https://cloudflare-dns.com/dns-query",
  google: "https://dns.google/resolve",
};

export interface DnsResult {
  // NXDOMAIN heißt: diese Domain gibt es gar nicht.
  exists: boolean;
  answers: string[];
}

const DNS_TYPES = { A: 1, MX: 15, TXT: 16 } as const;

export async function dns(resolver: Resolver, name: string, type: keyof typeof DNS_TYPES): Promise<DnsResult> {
  const url = `${RESOLVERS[resolver]}?name=${encodeURIComponent(name)}&type=${type}`;
  const res = await fetch(url, {
    headers: { accept: "application/dns-json" },
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) throw new Error(`DNS service answered ${res.status}`);
  const data = (await res.json()) as { Status?: number; Answer?: { type: number; data: string }[] };
  if (data.Status === 3) return { exists: false, answers: [] };
  if (data.Status !== 0) throw new Error(`DNS lookup failed (status ${data.Status ?? "?"})`);
  const answers = (data.Answer ?? [])
    .filter((a) => a.type === DNS_TYPES[type])
    // TXT kommt in Anführungszeichen und lange Einträge in Stücken: "ab" "cd"
    .map((a) => (type === "TXT" ? a.data.replace(/"\s*"/g, "").replace(/^"|"$/g, "") : a.data));
  return { exists: true, answers };
}

export interface WikidataFacts {
  id: string;
  label: string;
  country: string | null;
  employees: number | null;
  employeesYear: string | null;
  linkedin: string | null;
}

// Gesucht wird über die offizielle Website (Eigenschaft P856), nicht über
// den Namen. So gibt es keine Verwechslung mit gleichnamigen Firmen.
// Personen fallen raus: bei hubspot.com trägt auch der Gründer diese Website.
// Eine Prüfung "ist eine Organisation" über alle Unterklassen wäre genauer,
// dauerte im Test aber 8 bis 18 Sekunden statt unter 2.
export function wikidataQuery(domain: string): string {
  const variants = ["https://", "http://", "https://www.", "http://www."]
    .flatMap((p) => [`<${p}${domain}>`, `<${p}${domain}/>`])
    .join(" ");
  return `SELECT ?item ?itemLabel ?countryLabel ?employees ?asOf ?linkedin WHERE {
  VALUES ?site { ${variants} }
  ?item wdt:P856 ?site .
  FILTER NOT EXISTS { ?item wdt:P31 wd:Q5 }
  OPTIONAL { VALUES ?coType { wd:Q4830453 wd:Q783794 wd:Q6881511 wd:Q891723 wd:Q1589009 } ?item wdt:P31 ?coType . BIND(1 AS ?isCo) }
  OPTIONAL { ?item wdt:P17 ?country }
  OPTIONAL { ?item p:P1128 ?st . ?st ps:P1128 ?employees . OPTIONAL { ?st pq:P585 ?asOf } }
  OPTIONAL { ?item wdt:P4264 ?linkedin }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
} LIMIT 40`;
}

type Binding = Record<string, { value: string } | undefined>;

export function parseWikidata(bindings: Binding[]): WikidataFacts | null {
  // Mehrere Einträge mit derselben Website (Firma und Produkt): die Firma zuerst.
  const firstId = (bindings.find((b) => b.isCo?.value) ?? bindings[0])?.item?.value;
  if (!firstId) return null;
  const rows = bindings.filter((b) => b.item?.value === firstId);
  // Mitarbeiterzahl: der jüngste Stand, falls mehrere angegeben sind.
  const staff = rows
    .filter((b) => b.employees?.value)
    .map((b) => ({ n: Number(b.employees!.value), at: b.asOf?.value ?? "" }))
    .filter((s) => Number.isFinite(s.n) && s.n > 0)
    .sort((a, b) => b.at.localeCompare(a.at));
  const top = staff[0];
  const id = firstId.split("/").pop() ?? firstId;
  const label = rows[0]?.itemLabel?.value ?? "";
  return {
    id,
    // Ohne englischen Namen liefert Wikidata die ID als Namen zurück.
    label: label === id ? "" : label,
    country: rows.find((b) => b.countryLabel?.value)?.countryLabel?.value ?? null,
    employees: top ? Math.round(top.n) : null,
    employeesYear: top?.at ? top.at.slice(0, 4) : null,
    linkedin: rows.find((b) => b.linkedin?.value)?.linkedin?.value ?? null,
  };
}

export async function wikidata(domain: string): Promise<WikidataFacts | null> {
  const url = `https://query.wikidata.org/sparql?query=${encodeURIComponent(wikidataQuery(domain))}`;
  const res = await fetch(url, {
    headers: { accept: "application/sparql-results+json", "user-agent": USER_AGENT },
    signal: AbortSignal.timeout(6000),
  });
  if (res.status === 429) throw new Error("Wikidata is busy (429), try again later");
  if (!res.ok) throw new Error(`Wikidata answered ${res.status}`);
  const data = (await res.json()) as { results?: { bindings?: Binding[] } };
  return parseWikidata(data.results?.bindings ?? []);
}
