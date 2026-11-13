// Reine Textauswertung ohne Netz und ohne AI: HTML, DNS-Einträge und
// Domainnamen rein, Befunde mit Beleg raus. Dieselbe Eingabe ergibt immer
// dasselbe Ergebnis, deshalb ist hier alles mit Tests abgedeckt.
// Erkennungsmuster für Startseiten und Handlungsaufrufe: Vorlage GTM OS,
// src/signals.ts.

export interface Found {
  value: string;
  evidence: string;
}

function decode(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)));
}

export function meta(html: string, name: string): string {
  const tag = html.match(new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]*>`, "i"))?.[0];
  return decode(tag?.match(/content=["']([^"']*)["']/i)?.[1] ?? "").replace(/\s+/g, " ").trim();
}

export function visibleText(html: string): string {
  return decode(
    html
      .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

export function pageTitle(html: string): string {
  return decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").replace(/\s+/g, " ").trim();
}

/* ---------- Firmenname ---------- */

const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

// "Calendly.com" wird zu "Calendly": die Endung gehört nicht zum Namen.
export function siteName(html: string, domain = ""): string {
  const name = (meta(html, "og:site_name") || meta(html, "application-name")).slice(0, 80);
  const tld = domain.split(".").pop() ?? "";
  if (tld && compact(name) === compact(domain)) return name.slice(0, -(tld.length + 1)) || name;
  return name;
}

// Titel wie "The CRM for small teams | Pipedrive" enthalten den Namen meist
// als einen Teil. Genommen wird der Teil, der dem Domainnamen am ähnlichsten
// ist. Passt keiner, ist der Titel als Name unbrauchbar.
export function nameFromTitle(title: string, domain: string): string | null {
  const label = compact(domain.split(".")[0] ?? "");
  if (!label) return null;
  const parts = title
    .split(/\s[|–—·:-]\s|\s?\|\s?/)
    .map((p) => p.trim())
    .filter((p) => p.length > 1 && p.length <= 60);
  const exact = parts.find((p) => compact(p) === label);
  if (exact) return exact;
  const close = parts.find((p) => compact(p).startsWith(label) && p.split(/\s+/).length <= 3);
  return close ?? null;
}

export function nameFromDomain(domain: string): string {
  const label = domain.split(".")[0] ?? domain;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/* ---------- CRM ---------- */

const CRM_HTML: [string, RegExp][] = [
  ["HubSpot", /js\.hs-scripts\.com|js\.hsforms\.net|js\.hs-analytics\.net|hsforms\.com|js\.hubspot\.com/i],
  ["Salesforce", /pi\.pardot\.com|go\.pardot\.com|force\.com\/|salesforce\.com\/servlet|webto\.salesforce\.com/i],
  ["Marketo", /munchkin\.marketo\.net|mktoforms|marketo\.com\/js/i],
  ["Pipedrive", /webforms\.pipedrive\.com|leadbooster-chat\.pipedrive\.com/i],
  ["Zoho CRM", /salesiq\.zoho\.(com|eu)|crm\.zoho\.(com|eu)|zohopublic/i],
  ["ActiveCampaign", /trackcmp\.net|activehosted\.com/i],
];

export function crmFromHtml(html: string): Found[] {
  const out: Found[] = [];
  for (const [name, re] of CRM_HTML) {
    const m = html.match(re);
    if (m) out.push({ value: name, evidence: m[0] });
  }
  return out;
}

// SPF-Einträge listen alle Dienste, die im Namen der Firma Mails versenden
// dürfen. Wer über HubSpot oder Salesforce Mails verschickt, nutzt es.
const CRM_SPF: [string, RegExp][] = [
  ["HubSpot", /hubspotemail\.net|_hspf\.hubspot\.com/i],
  ["Salesforce", /_spf\.salesforce\.com|aspmx\.pardot\.com/i],
  ["Marketo", /mktomail\.com/i],
];

// Prüf-Einträge: ein Dienst lässt die Firma per DNS beweisen, dass ihr die
// Domain gehört. Der Eintrag bleibt danach meist stehen.
const CRM_TXT: [string, RegExp][] = [
  ["HubSpot", /^hubspot-developer-verification=/i],
  // Salesforce-Organisationen haben IDs, die mit 00D beginnen.
  ["Salesforce", /^00D[A-Za-z0-9]{12,15}=|^pardot_?\d*[_-]/i],
];

export function spfRecord(txt: string[]): string | null {
  return txt.find((t) => /^v=spf1\b/i.test(t)) ?? null;
}

function scan(records: string[], table: [string, RegExp][]): Found[] {
  const out: Found[] = [];
  for (const [name, re] of table) {
    if (out.some((f) => f.value === name)) continue;
    for (const r of records) {
      const m = r.match(re);
      if (m) {
        out.push({ value: name, evidence: m[0] });
        break;
      }
    }
  }
  return out;
}

export function crmFromSpf(txt: string[]): Found[] {
  const spf = spfRecord(txt);
  return spf ? scan([spf], CRM_SPF) : [];
}

export function crmFromTxt(txt: string[]): Found[] {
  return scan(txt, CRM_TXT);
}

/* ---------- Mail-Anbieter ---------- */

const MAIL_MX: [string, RegExp][] = [
  ["Google Workspace", /(^|\.)(google\.com|googlemail\.com)$/],
  ["Microsoft 365", /\.(mail\.protection\.outlook\.com|outlook\.com)$/],
  ["Zoho Mail", /\.zoho\.(com|eu|in)$/],
  ["Proton Mail", /\.protonmail\.ch$/],
  ["IONOS", /\.(ionos\.(de|com)|1and1\.(com|de)|kundenserver\.de)$/],
  ["GoDaddy", /\.secureserver\.net$/],
  ["Fastmail", /\.messagingengine\.com$/],
  ["iCloud Mail", /\.icloud\.com$/],
  ["Amazon WorkMail / SES", /\.amazonaws\.com$/],
];

// Sicherheits-Filter stehen vor dem eigentlichen Postfach. Ihr MX-Eintrag
// verrät deshalb nicht, wo die Mails am Ende landen.
const MAIL_GATEWAYS: [string, RegExp][] = [
  ["Proofpoint", /\.pphosted\.com$|\.ppe-hosted\.com$/],
  ["Mimecast", /\.mimecast\.com$/],
  ["Barracuda", /\.barracudanetworks\.com$/],
  ["Cisco Secure Email", /\.iphmx\.com$/],
  ["Broadcom (Symantec)", /\.messagelabs\.com$/],
  ["Hornetsecurity", /\.hornetsecurity\.com$/],
  ["Trend Micro", /\.tmes\.trendmicro\.(com|eu)$/],
];

export interface MxVerdict {
  provider: string | null;
  gateway: string | null;
  host: string;
}

export function mxHosts(answers: string[]): string[] {
  // DNS-Antwort sieht aus wie "10 aspmx.l.google.com." (Priorität, Host)
  return answers
    .map((a) => a.trim().split(/\s+/))
    .map(([prio, host]) => ({ prio: Number(prio), host: (host ?? "").toLowerCase().replace(/\.$/, "") }))
    .filter((m) => m.host)
    .sort((a, b) => a.prio - b.prio)
    .map((m) => m.host);
}

export function mailFromMx(hosts: string[]): MxVerdict {
  const host = hosts[0] ?? "";
  for (const h of hosts) {
    const p = MAIL_MX.find(([, re]) => re.test(h));
    if (p) return { provider: p[0], gateway: null, host: h };
  }
  const g = MAIL_GATEWAYS.find(([, re]) => hosts.some((h) => re.test(h)));
  return { provider: null, gateway: g?.[0] ?? null, host };
}

const MAIL_SPF: [string, RegExp][] = [
  ["Google Workspace", /include:_spf\.google\.com/i],
  ["Microsoft 365", /include:spf\.protection\.outlook\.com/i],
  ["Zoho Mail", /include:zoho\.(com|eu)|include:zcsend\.net/i],
  ["IONOS", /include:_spf\.perfora\.net|include:_spf-[a-z]+\.ionos\./i],
];

export function mailFromSpf(txt: string[]): Found | null {
  const spf = spfRecord(txt);
  if (!spf) return null;
  for (const [name, re] of MAIL_SPF) {
    const m = spf.match(re);
    if (m) return { value: name, evidence: m[0] };
  }
  return null;
}

/* ---------- Vertriebsweg ---------- */

const SALES_CTA = /\b(book (a|your) (demo|call|meeting)|request (a )?demo|get a demo|schedule (a )?(demo|call)|talk to (sales|an expert)|contact sales|demo (buchen|anfragen|vereinbaren)|beratungsgespr[aä]ch|termin (buchen|vereinbaren)|angebot anfordern|get a quote|request a quote)\b/i;
const PRODUCT_CTA = /\b(start (for )?free|try (it )?(for )?free|sign up( for free)?|get started( for free)?|start (your )?(free )?trial|free trial|create (an |your )?account|kostenlos (testen|starten|registrieren)|jetzt (testen|registrieren))\b/i;
const SHOP_CTA = /\b(add to cart|shop now|in den warenkorb|zur kasse)\b/i;

export type Motion = "Sales-led" | "Product-led" | "Hybrid" | "E-commerce";

function first(text: string, re: RegExp): string | null {
  return text.match(re)?.[0]?.toLowerCase() ?? null;
}

export function motionFromHtml(html: string): { motion: Motion; evidence: string } | null {
  const text = visibleText(html);
  const sales = first(text, SALES_CTA);
  const product = first(text, PRODUCT_CTA);
  const shop = first(text, SHOP_CTA);
  if (sales && product) return { motion: "Hybrid", evidence: `"${sales}" and "${product}"` };
  if (sales) return { motion: "Sales-led", evidence: `"${sales}"` };
  if (product) return { motion: "Product-led", evidence: `"${product}"` };
  if (shop) return { motion: "E-commerce", evidence: `"${shop}"` };
  return null;
}

// Link auf die Preisseite, falls die Startseite einen hat. Nur gleiche
// Domain, damit der zweite Abruf nicht auf fremden Seiten landet.
export function pricingUrl(html: string, domain: string): string | null {
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["']/gi)) {
    const href = m[1] ?? "";
    if (!/\/(pricing|preise|plans|tarife)\/?(\?|$)/i.test(href)) continue;
    try {
      const url = new URL(href, `https://${domain}/`);
      const host = url.hostname.replace(/^www\./, "");
      if (url.protocol === "https:" && (host === domain || host.endsWith(`.${domain}`))) return url.href;
    } catch {
      /* kaputter Link, nächster */
    }
  }
  return null;
}

/* ---------- LinkedIn ---------- */

export function linkedinFromHtml(html: string): string | null {
  const m = html.match(/https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/company\/([a-z0-9][a-z0-9_.%-]{0,99})/i);
  return m ? `https://www.linkedin.com/company/${m[1]!.toLowerCase().replace(/\/$/, "")}` : null;
}

/* ---------- Land ---------- */

// Nur Länderendungen, die in der Praxis wirklich ein Land bedeuten.
// .io, .co, .ai, .me und ähnliche werden weltweit benutzt und zählen nicht.
const CCTLD: Record<string, string> = {
  de: "Germany", at: "Austria", ch: "Switzerland", fr: "France", it: "Italy", es: "Spain", nl: "Netherlands",
  be: "Belgium", lu: "Luxembourg", dk: "Denmark", se: "Sweden", no: "Norway", fi: "Finland", pl: "Poland",
  cz: "Czech Republic", pt: "Portugal", ie: "Ireland", uk: "United Kingdom", us: "United States",
  ca: "Canada", au: "Australia", nz: "New Zealand", jp: "Japan", br: "Brazil", in: "India", mx: "Mexico",
  ee: "Estonia", lt: "Lithuania", lv: "Latvia", hu: "Hungary", gr: "Greece", ro: "Romania", sk: "Slovakia",
  si: "Slovenia", hr: "Croatia", il: "Israel", za: "South Africa", sg: "Singapore", kr: "South Korea",
};

export function countryFromTld(domain: string): Found | null {
  const tld = domain.split(".").pop() ?? "";
  const country = CCTLD[tld];
  return country ? { value: country, evidence: `.${tld}` } : null;
}
