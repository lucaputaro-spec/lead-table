// Zielkunden-Filter. Feste Regeln, keine AI: jede Zeile bekommt pro
// eingeschalteter Regel ein Ja, Nein oder "unbekannt", jeweils mit Grund.
// Unbekannt zählt nicht als Treffer, wird aber anders angezeigt als ein Nein,
// weil fehlende Daten etwas anderes sind als ein klares Nein.

/**
 * crm: belegter Einsatz (Skript auf der Seite, Mailversand per SPF).
 * crmWeak: nur ein Hinweis (DNS-Prüfeintrag), kein Beleg für den Einsatz.
 * @typedef {{ crm: string[], crmWeak?: string[], motion: string | null, mail: string | null, country: string | null, employees: number | null }} Facts
 * @typedef {{ id: string, label: string, check: (f: Facts, option: string) => { ok: boolean | null, why: string } }} Rule
 * @typedef {{ id: string, label: string, ok: boolean | null, why: string }} Verdict
 */

const DEMO = new Set(["Sales-led", "Hybrid"]);
const SELF = new Set(["Product-led", "Hybrid"]);

/**
 * @param {string} name
 * @returns {Rule["check"]}
 */
function usesCrm(name) {
  // Nur ein belegter Einsatz zählt als Ja. Ein Nein gibt es nicht: ein
  // anderes CRM schließt dieses nicht aus (viele Firmen nutzen zwei), und
  // fehlende Daten sind kein Nein.
  return (f) => {
    if (f.crm.includes(name)) return { ok: true, why: `${name} found` };
    if (f.crmWeak?.includes(name)) return { ok: null, why: `${name} signal only (DNS verification record), not proof it is in use` };
    if (f.crm.length) return { ok: null, why: `${f.crm.join(", ")} found, which does not rule out ${name}` };
    return { ok: null, why: "no CRM visible" };
  };
}

/** @type {Rule[]} */
export const RULES = [
  { id: "hubspot", label: "Uses HubSpot", check: usesCrm("HubSpot") },
  { id: "salesforce", label: "Uses Salesforce", check: usesCrm("Salesforce") },
  {
    id: "demos",
    label: "Sells through demos",
    check: (f) =>
      f.motion === null || f.motion === "Unclear"
        ? { ok: null, why: "sales motion unclear" }
        : { ok: DEMO.has(f.motion), why: `${f.motion.toLowerCase()}` },
  },
  {
    id: "selfserve",
    label: "Has a self-serve signup",
    check: (f) =>
      f.motion === null || f.motion === "Unclear"
        ? { ok: null, why: "sales motion unclear" }
        : { ok: SELF.has(f.motion), why: `${f.motion.toLowerCase()}` },
  },
  {
    id: "google",
    label: "Runs on Google Workspace",
    check: (f) =>
      f.mail ? { ok: f.mail === "Google Workspace", why: `mail on ${f.mail}` } : { ok: null, why: "mail provider unknown" },
  },
  {
    id: "microsoft",
    label: "Runs on Microsoft 365",
    check: (f) =>
      f.mail ? { ok: f.mail === "Microsoft 365", why: `mail on ${f.mail}` } : { ok: null, why: "mail provider unknown" },
  },
  {
    id: "size",
    label: "At least 200 employees",
    check: (f) =>
      f.employees === null
        ? { ok: null, why: "headcount unknown" }
        : { ok: f.employees >= 200, why: `${f.employees.toLocaleString("en-US")} employees` },
  },
  {
    id: "country",
    label: "Based in",
    check: (f, option) =>
      f.country === null ? { ok: null, why: "country unknown" } : { ok: f.country === option, why: `based in ${f.country}` },
  },
];

/**
 * @param {Facts} facts
 * @param {{ id: string, option?: string }[]} active
 * @returns {{ hits: number, total: number, verdicts: Verdict[] }}
 */
export function judge(facts, active) {
  /** @type {Verdict[]} */
  const verdicts = [];
  for (const a of active) {
    const rule = RULES.find((r) => r.id === a.id);
    if (!rule) continue;
    const { ok, why } = rule.check(facts, a.option ?? "");
    const label = rule.id === "country" ? `${rule.label} ${a.option ?? ""}`.trim() : rule.label;
    verdicts.push({ id: rule.id, label, ok, why });
  }
  return { hits: verdicts.filter((v) => v.ok === true).length, total: verdicts.length, verdicts };
}

/**
 * Sortiert stabil: mehr Treffer zuerst, bei Gleichstand weniger klare
 * Neins zuerst, dann die ursprüngliche Reihenfolge.
 * @template {{ n: number, fit: { hits: number, verdicts: Verdict[] } | null }} T
 * @param {T[]} rows
 * @returns {T[]}
 */
export function rank(rows) {
  const misses = (/** @type {T} */ r) => r.fit?.verdicts.filter((v) => v.ok === false).length ?? 99;
  return [...rows].sort((a, b) => {
    const byHits = (b.fit?.hits ?? -1) - (a.fit?.hits ?? -1);
    if (byHits) return byHits;
    const byMisses = misses(a) - misses(b);
    return byMisses || a.n - b.n;
  });
}
