import { describe, expect, it } from "vitest";
import { findLateDuplicates, normalizeDomain, parseList, MAX_ROWS } from "../public/lib/list.js";
import { judge, rank } from "../public/lib/icp.js";
import { csvCell, toCsv } from "../public/lib/csv.js";
import { hit, miss, waterfall } from "../src/waterfall";
import {
  countryFromTld,
  crmFromHtml,
  crmFromSpf,
  crmFromTxt,
  linkedinFromHtml,
  mailFromMx,
  mailFromSpf,
  motionFromHtml,
  mxHosts,
  nameFromTitle,
  pricingUrl,
  siteName,
} from "../src/extract";
import { parseWikidata, wikidataQuery } from "../src/sources";
import { checkHook, parseHook, templateHook, writeHook, type AiEnv } from "../src/ai";
import { enrich, type Deps } from "../src/enrich";

describe("list cleanup", () => {
  it("normalizes spellings of the same site", () => {
    for (const s of ["https://www.Stripe.com/", "stripe.com", "STRIPE.COM.", "jane@stripe.com", "http://stripe.com/pricing?x=1"]) {
      expect(normalizeDomain(s)).toBe("stripe.com");
    }
  });

  it("rejects things that are not public websites", () => {
    for (const s of ["not a website", "localhost", "10.0.0.1", "foo.internal", "x.workers.dev", "stripe.com:8080", ""]) {
      expect(normalizeDomain(s)).toBeNull();
    }
  });

  it("marks exact duplicates and broken entries, caps the list", () => {
    const { rows, dropped } = parseList("stripe.com\nhttps://www.stripe.com/\n\nnope\nhubspot.com");
    expect(rows.map((r) => [r.domain, r.duplicateOf])).toEqual([
      ["stripe.com", null],
      ["stripe.com", 1],
      [null, null],
      ["hubspot.com", null],
    ]);
    expect(dropped).toBe(0);
    const many = parseList(Array.from({ length: 30 }, (_, i) => `site${i}.com`).join(","));
    expect(many.rows).toHaveLength(MAX_ROWS);
    expect(many.dropped).toBe(30 - MAX_ROWS);
  });

  it("finds duplicates that only show after enrichment", () => {
    const dupes = findLateDuplicates([
      { n: 1, finalHost: "notion.com", wikidataId: "Q1" },
      { n: 2, finalHost: "www.notion.com", wikidataId: null },
      { n: 3, finalHost: null, wikidataId: "Q1" },
      { n: 4, finalHost: "other.com", wikidataId: "Q9" },
    ]);
    expect(dupes.get(2)?.of).toBe(1);
    expect(dupes.get(3)?.of).toBe(1);
    expect(dupes.has(4)).toBe(false);
  });

  it("keeps the row whose domain is where the redirect lands", () => {
    const dupes = findLateDuplicates([
      { n: 5, domain: "notion.so", finalHost: "notion.com", wikidataId: "Q8" },
      { n: 17, domain: "notion.com", finalHost: "notion.com", wikidataId: "Q8" },
    ]);
    expect(dupes.get(5)).toEqual({ of: 17, why: "both end up on notion.com" });
    expect(dupes.has(17)).toBe(false);
  });
});

describe("target customer rules", () => {
  const facts = { crm: ["HubSpot"], motion: "Sales-led", mail: "Google Workspace", country: "Germany", employees: 120 };

  it("explains every verdict and treats missing data as unknown, not no", () => {
    const r = judge(facts, [{ id: "hubspot" }, { id: "demos" }, { id: "size" }, { id: "country", option: "Germany" }]);
    expect(r.hits).toBe(3);
    expect(r.verdicts.find((v) => v.id === "size")).toMatchObject({ ok: false, why: "120 employees" });
    const empty = judge({ crm: [], motion: null, mail: null, country: null, employees: null }, [{ id: "hubspot" }, { id: "demos" }]);
    expect(empty.verdicts.every((v) => v.ok === null)).toBe(true);
  });

  it("keeps 'Uses HubSpot' open for a DNS verification signal", () => {
    const v = judge({ ...facts, crm: [], crmWeak: ["HubSpot"] }, [{ id: "hubspot" }]).verdicts[0];
    expect(v).toMatchObject({ ok: null, why: expect.stringContaining("signal only") });
  });

  it("does not rule HubSpot out because Salesforce was found", () => {
    const v = judge({ ...facts, crm: ["Salesforce"] }, [{ id: "hubspot" }]).verdicts[0];
    expect(v).toMatchObject({ ok: null, why: "Salesforce found, which does not rule out HubSpot" });
    expect(judge({ ...facts, crm: ["Salesforce"] }, [{ id: "salesforce" }]).verdicts[0]?.ok).toBe(true);
  });

  it("does not let weak or missing CRM signals change the ranking", () => {
    const base = { motion: "Sales-led", mail: null, country: null, employees: null };
    const rows = [
      { n: 1, facts: { ...base, crm: [] } },
      { n: 2, facts: { ...base, crm: ["Salesforce"] } },
      { n: 3, facts: { ...base, crm: [], crmWeak: ["HubSpot"] } },
      { n: 4, facts: { ...base, crm: ["HubSpot"] } },
    ].map((r) => ({ n: r.n, fit: judge(r.facts, [{ id: "hubspot" }, { id: "demos" }]) }));
    // Nur Zeile 4 hat einen belegten Treffer mehr. 1 bis 3 bleiben gleichauf in Listenreihenfolge.
    expect(rank(rows).map((r) => r.n)).toEqual([4, 1, 2, 3]);
    expect(rows.slice(0, 3).map((r) => r.fit.hits)).toEqual([1, 1, 1]);
  });

  it("ranks by hits, then fewer clear misses, then list order", () => {
    const v = (ok: boolean | null) => ({ id: "x", label: "x", ok, why: "" });
    const rows = [
      { n: 1, fit: { hits: 0, verdicts: [v(false)] } },
      { n: 2, fit: { hits: 1, verdicts: [v(true)] } },
      { n: 3, fit: { hits: 0, verdicts: [v(null)] } },
      { n: 4, fit: null },
    ];
    expect(rank(rows).map((r) => r.n)).toEqual([2, 3, 1, 4]);
  });
});

describe("csv", () => {
  it("quotes and defuses formulas", () => {
    expect(csvCell('say "hi", ok')).toBe('"say ""hi"", ok"');
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell(null)).toBe("");
    expect(toCsv(["a", "b"], [[1, "x"]])).toBe("a,b\r\n1,x\r\n");
  });
});

describe("waterfall", () => {
  it("stops at the first source that answers and records the rest as not asked", async () => {
    const asked: string[] = [];
    const cell = await waterfall([
      { name: "A", ask: async () => (asked.push("A"), miss("nothing")) },
      { name: "B", ask: async () => { asked.push("B"); throw new Error("down"); } },
      { name: "C", ask: async () => (asked.push("C"), hit("found", "here")) },
      { name: "D", ask: async () => (asked.push("D"), hit("too late", "")) },
    ]);
    expect(asked).toEqual(["A", "B", "C"]);
    expect(cell).toMatchObject({ value: "found", source: "C", step: 3 });
    expect(cell.trail.map((s) => s.status)).toEqual(["miss", "error", "hit", "skipped"]);
    expect(cell.trail[1]?.note).toBe("down");
  });

  it("leaves the cell empty when every source misses", async () => {
    const cell = await waterfall([{ name: "A", ask: async () => miss("no") }]);
    expect(cell).toMatchObject({ value: null, source: null, step: null });
  });
});

describe("reading sources", () => {
  it("reads the mail provider from MX, and sees through spam filters", () => {
    expect(mxHosts(["20 alt1.aspmx.l.google.com.", "10 aspmx.l.google.com."])).toEqual(["aspmx.l.google.com", "alt1.aspmx.l.google.com"]);
    expect(mailFromMx(["acme-com.mail.protection.outlook.com"]).provider).toBe("Microsoft 365");
    expect(mailFromMx(["smtp.google.com"]).provider).toBe("Google Workspace");
    expect(mailFromMx(["mxa-001.pphosted.com"])).toMatchObject({ provider: null, gateway: "Proofpoint" });
    expect(mailFromSpf(["v=spf1 include:spf.protection.outlook.com -all"])?.value).toBe("Microsoft 365");
  });

  it("finds CRMs in page source, SPF and verification records", () => {
    expect(crmFromHtml('<script src="//js.hs-scripts.com/123.js"></script>').map((f) => f.value)).toEqual(["HubSpot"]);
    expect(crmFromSpf(["google-site-verification=x", "v=spf1 include:_spf.google.com include:_spf.salesforce.com -all"]).map((f) => f.value)).toEqual(["Salesforce"]);
    expect(crmFromSpf(["v=spf1 redirect=_hspf.hubspot.com"]).map((f) => f.value)).toEqual(["HubSpot"]);
    expect(crmFromTxt(["hubspot-developer-verification=abc", "00D50000000JV6w=1TBTQ"]).map((f) => f.value)).toEqual(["HubSpot", "Salesforce"]);
    expect(crmFromTxt(["MS=ms123", "docusign=1"])).toEqual([]);
  });

  it("reads the sales motion from button text", () => {
    expect(motionFromHtml("<a>Book a demo</a><a>Start free trial</a>")?.motion).toBe("Hybrid");
    expect(motionFromHtml("<button>Contact sales</button>")?.motion).toBe("Sales-led");
    expect(motionFromHtml("<script>book a demo</script><p>About us</p>")).toBeNull();
  });

  it("picks the company name out of a page title", () => {
    expect(nameFromTitle("The CRM for small teams | Pipedrive", "pipedrive.com")).toBe("Pipedrive");
    expect(nameFromTitle("n8n.io - a powerful workflow automation tool", "n8n.io")).toBe("n8n.io");
    expect(nameFromTitle("Welcome to our website", "acme.com")).toBeNull();
  });

  it("only follows pricing links on the same domain", () => {
    expect(pricingUrl('<a href="/pricing">Pricing</a>', "acme.com")).toBe("https://acme.com/pricing");
    expect(pricingUrl('<a href="https://evil.com/pricing">x</a>', "acme.com")).toBeNull();
    expect(pricingUrl('<a href="/blog/pricing-tips">x</a>', "acme.com")).toBeNull();
  });

  it("drops the domain ending from a site name", () => {
    expect(siteName('<meta property="og:site_name" content="Calendly.com">', "calendly.com")).toBe("Calendly");
    expect(siteName('<meta property="og:site_name" content="Stripe">', "stripe.com")).toBe("Stripe");
  });

  it("reads LinkedIn links and country domains", () => {
    expect(linkedinFromHtml('href="https://de.linkedin.com/company/Acme-GmbH/"')).toBe("https://www.linkedin.com/company/acme-gmbh");
    expect(countryFromTld("personio.de")?.value).toBe("Germany");
    expect(countryFromTld("n8n.io")).toBeNull();
  });

  it("matches Wikidata on the official website and takes the newest headcount", () => {
    expect(wikidataQuery("stripe.com")).toContain("<https://www.stripe.com/>");
    const b = (employees: string, asOf: string) => ({
      item: { value: "http://www.wikidata.org/entity/Q7624104" },
      itemLabel: { value: "Stripe" },
      countryLabel: { value: "United States" },
      employees: { value: employees },
      asOf: { value: asOf },
    });
    expect(parseWikidata([b("2500", "2019-01-01T00:00:00Z"), b("8000", "2023-01-01T00:00:00Z")])).toMatchObject({
      id: "Q7624104",
      label: "Stripe",
      employees: 8000,
      employeesYear: "2023",
    });
    expect(parseWikidata([])).toBeNull();
    const product = { item: { value: "http://www.wikidata.org/entity/Q2" }, itemLabel: { value: "Acme App" } };
    const company = { item: { value: "http://www.wikidata.org/entity/Q1" }, itemLabel: { value: "Acme" }, isCo: { value: "1" } };
    expect(parseWikidata([product, company])?.label).toBe("Acme");
    expect(wikidataQuery("acme.com")).toContain("FILTER NOT EXISTS { ?item wdt:P31 wd:Q5 }");
  });
});

describe("hook column", () => {
  it("accepts one clean sentence and rejects junk", () => {
    expect(parseHook('{"hook": "Acme asks visitors to book a demo, so reply speed matters."}')).toContain("Acme");
    expect(parseHook({ hook: "Acme asks visitors to book a demo, so reply speed matters." })).toContain("Acme");
    expect(parseHook("Sure! Here is a sentence")).toBe("");
    expect(parseHook('{"hook": "short"}')).toBe("");
  });

  it("rejects model sentences with invented numbers or a misspelled name", () => {
    const f = { company: "lemlist", domain: "lemlist.com", about: "Used by 10,000 teams", motion: "Hybrid", motionEvidence: "", crm: "", mail: "" };
    expect(checkHook("lemlist asks visitors to book a demo, so speed matters.", f)).toBe("");
    expect(checkHook("Lemplist asks visitors to book a demo.", f)).toContain("company name");
    expect(checkHook("lemlist serves 9,000 apps.", f)).toContain("9,000");
    expect(checkHook("lemlist is used by 10,000 teams.", f)).toBe("");
  });

  it("does not ask the model when there is nothing concrete to write about", async () => {
    let asked = false;
    const env = { AI: { run: async () => ((asked = true), { response: { hook: "x" } }) }, AI_MODEL: "m" } as unknown as AiEnv;
    const f = { company: "Acme", domain: "acme.com", about: "", motion: "", motionEvidence: "", crm: "", mail: "" };
    const out = await writeHook(env, f);
    expect(asked).toBe(false);
    expect(out.source).toBe("Template");
  });

  it("falls back to the template when the model fails", async () => {
    const env = { AI: { run: async () => { throw new Error("quota"); } }, AI_MODEL: "m" } as unknown as AiEnv;
    const f = { company: "Acme", domain: "acme.com", about: "", motion: "Sales-led", motionEvidence: '"book a demo"', crm: "", mail: "" };
    expect(await writeHook(env, f)).toMatchObject({ source: "Template", text: expect.stringContaining("book a demo") });
  });

  it("has a template for every case", () => {
    const base = { company: "Acme", domain: "acme.com", about: "", motionEvidence: "", crm: "", mail: "" };
    expect(templateHook({ ...base, motion: "Sales-led", motionEvidence: '"book a demo"' })).toContain("asks visitors to book a demo");
    expect(templateHook({ ...base, motion: "", crm: "HubSpot" })).toContain("runs HubSpot");
    expect(templateHook({ ...base, motion: "" })).toContain("Acme");
  });
});

describe("enrich one row (fake sources, no network)", () => {
  const ok = (html: string) => ({ ok: true as const, html, finalHost: "acme.de" });
  const deps = (over: Partial<Deps>): Deps => ({
    fetchPage: async () => ok("<title>Acme</title>"),
    dns: async () => ({ exists: true, answers: [] }),
    wikidata: async () => null,
    ...over,
  });

  it("marks a domain that does not exist as broken and asks nothing else", async () => {
    let fetched = false;
    const row = await enrich("nothere.de", deps({
      dns: async () => ({ exists: false, answers: [] }),
      fetchPage: async () => ((fetched = true), ok("")),
    }));
    expect(row.status).toBe("broken");
    expect(row.cells).toBeNull();
    expect(fetched).toBe(false);
  });

  it("falls through to DNS sources when the homepage blocks us", async () => {
    const row = await enrich("acme.de", deps({
      fetchPage: async () => ({ ok: false, reason: "blocks automated visitors (403)" }),
      dns: async (_r, _n, type) =>
        type === "MX"
          ? { exists: true, answers: ["10 mxa.pphosted.com."] }
          : { exists: true, answers: ["v=spf1 include:spf.protection.outlook.com include:_spf.salesforce.com -all"] },
    }));
    expect(row.status).toBe("partial");
    expect(row.cells?.mail).toMatchObject({ value: "Microsoft 365", source: "SPF record", step: 2 });
    expect(row.cells?.mail.trail[0]?.note).toContain("Proofpoint");
    expect(row.cells?.crm).toMatchObject({ value: "Salesforce", source: "SPF record", tags: ["Salesforce"] });
    expect(row.cells?.company).toMatchObject({ value: "Acme", source: "Domain name" });
    expect(row.cells?.country).toMatchObject({ value: "Germany", source: "Country domain" });
  });

  it("reports a DNS verification record as a weak CRM signal", async () => {
    const row = await enrich("acme.de", deps({
      dns: async (_r, _n, type) => (type === "TXT" ? { exists: true, answers: ["hubspot-developer-verification=abc"] } : { exists: true, answers: [] }),
    }));
    expect(row.cells?.crm).toMatchObject({ value: "HubSpot signal found", source: "DNS verification", weak: ["HubSpot"] });
    expect(row.cells?.crm.tags).toBeUndefined();
    expect(row.cells?.crm.trail[2]?.note).toContain("not proof");
  });

  it("uses Google DNS when 1.1.1.1 fails", async () => {
    const row = await enrich("acme.de", deps({
      dns: async (resolver) => {
        if (resolver === "cloudflare") throw new Error("down");
        return { exists: true, answers: ["1 smtp.google.com."] };
      },
    }));
    expect(row.cells?.mail.value).toBe("Google Workspace");
    expect(row.cells?.mail.trail[0]?.note).toContain("Google DNS");
  });

  it("prefers Wikidata over the country domain and survives a Wikidata outage", async () => {
    const wiki = { id: "Q1", label: "Acme AG", country: "Switzerland", employees: 300, employeesYear: "2024", linkedin: "acme" };
    const row = await enrich("acme.de", deps({ wikidata: async () => wiki }));
    expect(row.cells?.country).toMatchObject({ value: "Switzerland", source: "Wikidata" });
    expect(row.cells?.employees).toMatchObject({ value: "300", number: 300 });
    expect(row.cells?.linkedin.value).toBe("https://www.linkedin.com/company/acme");
    const down = await enrich("acme.de", deps({ wikidata: async () => { throw new Error("Wikidata is busy (429)"); } }));
    expect(down.cells?.country).toMatchObject({ value: "Germany", source: "Country domain" });
    expect(down.cells?.country.trail[0]?.status).toBe("error");
  });
});
