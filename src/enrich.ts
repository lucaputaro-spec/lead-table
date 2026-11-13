// Reichert eine Zeile an: eine Domain rein, alle Spalten raus. Jede Spalte
// ist ein eigener Wasserfall. Die Spalten laufen gleichzeitig, die Quellen
// innerhalb einer Spalte nacheinander.

import { fetchPage, type Page } from "./guard";
import {
  countryFromTld,
  crmFromHtml,
  crmFromSpf,
  crmFromTxt,
  linkedinFromHtml,
  mailFromMx,
  mailFromSpf,
  meta,
  motionFromHtml,
  mxHosts,
  nameFromDomain,
  nameFromTitle,
  pageTitle,
  pricingUrl,
  siteName,
  type Found,
} from "./extract";
import { dns, wikidata, type DnsResult, type Resolver, type WikidataFacts } from "./sources";
import { hit, miss, once, waterfall, type Answer, type Cell } from "./waterfall";

export interface Deps {
  fetchPage: (url: string) => Promise<Page>;
  dns: (resolver: Resolver, name: string, type: "A" | "MX" | "TXT") => Promise<DnsResult>;
  wikidata: (domain: string) => Promise<WikidataFacts | null>;
}

export const liveDeps: Deps = { fetchPage, dns, wikidata };

export const COLUMNS = ["company", "mail", "crm", "motion", "country", "employees", "linkedin"] as const;
export type Column = (typeof COLUMNS)[number];

export interface Row {
  domain: string;
  status: "ok" | "partial" | "broken";
  problems: string[];
  finalHost: string | null;
  wikidataId: string | null;
  about: string;
  cells: Record<Column, Cell> | null;
  ms: number;
}

const list = (found: Found[]) => found.map((f) => f.value).join(", ");
const proof = (found: Found[]) => found.map((f) => f.evidence).join(", ");

export async function enrich(domain: string, deps: Deps = liveDeps): Promise<Row> {
  const started = Date.now();

  // MX-Abfrage mit Ersatz-Resolver: antwortet 1.1.1.1 nicht, fragt Google.
  const mx = once(async (): Promise<DnsResult & { via: string }> => {
    try {
      return { ...(await deps.dns("cloudflare", domain, "MX")), via: "1.1.1.1" };
    } catch {
      return { ...(await deps.dns("google", domain, "MX")), via: "Google DNS, because 1.1.1.1 failed" };
    }
  });
  const txt = once(async () => {
    try {
      return (await deps.dns("cloudflare", domain, "TXT")).answers;
    } catch {
      return (await deps.dns("google", domain, "TXT")).answers;
    }
  });
  const home = once(() => deps.fetchPage(`https://${domain}/`));
  const wiki = once(() => deps.wikidata(domain));

  // Gibt es die Domain überhaupt? Wenn nicht, sparen wir uns alle weiteren Abrufe.
  const exists = await mx().then(
    (r) => r.exists,
    () => true,
  );
  if (!exists) {
    return {
      domain,
      status: "broken",
      problems: ["This domain does not exist in DNS."],
      finalHost: null,
      wikidataId: null,
      about: "",
      cells: null,
      ms: Date.now() - started,
    };
  }

  const fromHome = async (read: (html: string) => Answer): Promise<Answer> => {
    const page = await home();
    return page.ok ? read(page.html) : miss(`homepage ${page.reason}`);
  };
  const fromWiki = async (read: (w: WikidataFacts) => Answer): Promise<Answer> => {
    const w = await wiki();
    return w ? read(w) : miss(`no Wikidata entry lists ${domain} as its website`);
  };

  const [company, mail, crm, motion, country, employees, linkedin] = await Promise.all([
    waterfall([
      {
        name: "Homepage name tag",
        ask: () => fromHome((html) => {
          const name = siteName(html, domain);
          return name ? hit(name, `og:site_name says "${name}"`) : miss("no og:site_name tag");
        }),
      },
      {
        name: "Wikidata",
        ask: () => fromWiki((w) => (w.label ? hit(w.label, `entry ${w.id}`) : miss(`entry ${w.id} has no English name`))),
      },
      {
        name: "Homepage title",
        ask: () => fromHome((html) => {
          const title = pageTitle(html);
          const name = nameFromTitle(title, domain);
          return name ? hit(name, `from the title "${title.slice(0, 80)}"`) : miss(title ? "title does not contain a matching name" : "page has no title");
        }),
      },
      { name: "Domain name", ask: async () => hit(nameFromDomain(domain), "guessed from the domain, least reliable") },
    ]),

    waterfall([
      {
        name: "MX record",
        ask: async () => {
          const r = await mx();
          const hosts = mxHosts(r.answers);
          if (!hosts.length) return miss(`no MX record (asked ${r.via})`);
          const v = mailFromMx(hosts);
          if (v.provider) return hit(v.provider, `${v.host} (asked ${r.via})`);
          if (v.gateway) return miss(`${v.host} is a ${v.gateway} spam filter, the mailbox behind it is hidden`);
          return miss(`${v.host} is not a known provider`);
        },
      },
      {
        name: "SPF record",
        ask: async () => {
          const found = mailFromSpf(await txt());
          return found ? hit(found.value, `SPF allows ${found.evidence}`) : miss("SPF names no known mail provider");
        },
      },
      {
        name: "MX host as-is",
        ask: async () => {
          const hosts = mxHosts((await mx()).answers);
          if (!hosts.length) return miss("no mail server at all");
          const v = mailFromMx(hosts);
          return v.gateway ? hit(`Behind ${v.gateway}`, v.host) : hit("Other provider", v.host);
        },
      },
    ]),

    waterfall([
      {
        name: "Homepage scripts",
        ask: () => fromHome((html) => {
          const found = crmFromHtml(html);
          return found.length ? hit(list(found), `loads ${proof(found)}`, { tags: found.map((f) => f.value) }) : miss("no CRM script in the page source");
        }),
      },
      {
        name: "SPF record",
        ask: async () => {
          const found = crmFromSpf(await txt());
          return found.length ? hit(list(found), `sends mail via ${proof(found)}`, { tags: found.map((f) => f.value) }) : miss("SPF names no CRM");
        },
      },
      {
        name: "DNS verification",
        ask: async () => {
          const found = crmFromTxt(await txt());
          return found.length
            ? // Ein Prüf-Eintrag zeigt ein Konto bei dem Dienst, nicht, dass er als
              // CRM genutzt wird. Deshalb nur „Signal“, nicht „nutzt“.
              hit(`${list(found)} signal found`, `TXT record ${proof(found)}… shows an account, not proof the CRM is in use`, {
                weak: found.map((f) => f.value),
              })
            : miss("no CRM verification record");
        },
      },
    ]),

    waterfall([
      {
        name: "Homepage buttons",
        ask: () => fromHome((html) => {
          const m = motionFromHtml(html);
          return m ? hit(m.motion, `button text ${m.evidence}`) : miss("no demo, signup or cart button found");
        }),
      },
      {
        name: "Pricing page",
        ask: async () => {
          const page = await home();
          if (!page.ok) return miss("needs the homepage to find the pricing link");
          const url = pricingUrl(page.html, domain);
          if (!url) return miss("homepage links to no pricing page");
          const pricing = await deps.fetchPage(url);
          if (!pricing.ok) return miss(`pricing page ${pricing.reason}`);
          const m = motionFromHtml(pricing.html);
          return m ? hit(m.motion, `${new URL(url).pathname}: ${m.evidence}`) : miss("no demo or signup button on the pricing page");
        },
      },
    ]),

    waterfall([
      { name: "Wikidata", ask: () => fromWiki((w) => (w.country ? hit(w.country, `entry ${w.id}`) : miss(`entry ${w.id} names no country`))) },
      {
        name: "Country domain",
        ask: async () => {
          const c = countryFromTld(domain);
          return c ? hit(c.value, `ends in ${c.evidence}`) : miss(`.${domain.split(".").pop()} is used worldwide`);
        },
      },
    ]),

    waterfall([
      {
        name: "Wikidata",
        ask: () => fromWiki((w) =>
          w.employees
            ? hit(w.employees.toLocaleString("en-US"), `entry ${w.id}${w.employeesYear ? `, as of ${w.employeesYear}` : ""}`, { number: w.employees })
            : miss(`entry ${w.id} has no headcount`),
        ),
      },
    ]),

    waterfall([
      {
        name: "Homepage link",
        ask: () => fromHome((html) => {
          const url = linkedinFromHtml(html);
          return url ? hit(url, "linked from the homepage") : miss("no LinkedIn company link");
        }),
      },
      {
        name: "Wikidata",
        ask: () => fromWiki((w) =>
          w.linkedin ? hit(`https://www.linkedin.com/company/${w.linkedin}`, `entry ${w.id}`) : miss(`entry ${w.id} has no LinkedIn ID`),
        ),
      },
    ]),
  ]);

  const page = await home();
  const w = await wiki().catch(() => null);
  const mxr = await mx().catch(() => null);
  const problems: string[] = [];
  if (!page.ok) problems.push(`Homepage ${page.reason}.`);
  if (mxr && !mxr.answers.length) problems.push("No mail server: emails to this domain would bounce.");
  const broken = !page.ok && mxr !== null && !mxr.answers.length;

  return {
    domain,
    status: broken ? "broken" : problems.length ? "partial" : "ok",
    problems,
    finalHost: page.ok ? page.finalHost || domain : null,
    wikidataId: w?.id ?? null,
    about: page.ok ? (meta(page.html, "description") || meta(page.html, "og:description")).slice(0, 300) : "",
    cells: { company, mail, crm, motion, country, employees, linkedin },
    ms: Date.now() - started,
  };
}
