# Lead Table: list enrichment, live

Paste a list of company websites and watch every column fill itself, row by
row, from free public sources. Live at
https://lead-table.lucaputaro.workers.dev

## The waterfall

Each column asks several sources in a fixed order. The first one that answers
wins, the rest are never asked, and every cell shows which step filled it.
Click a cell to see the whole chain with what each source said and how long it took.

| Column | Sources, in order |
|---|---|
| Company | homepage `og:site_name` → Wikidata → page title → domain |
| Email provider | MX record (1.1.1.1, Google DNS as fallback) → SPF record → raw MX host |
| CRM | homepage scripts → SPF includes → DNS verification records |
| Sales motion | homepage button text → pricing page |
| Country | Wikidata → country-code domain |
| Employees | Wikidata |
| LinkedIn | homepage link → Wikidata |
| Opening line | Workers AI → template |

## Also

- **Clean-up.** Same site in another spelling is caught before any lookup.
  Different domains that redirect to the same site, or share a Wikidata
  entry, are caught after. Invalid and non-existent domains are marked.
- **Target-customer rules.** Toggle rules such as "uses HubSpot" or "sells
  through demos". Rows sort by matches, each verdict shows its reason, and
  missing data counts as unknown, not as no. A DNS verification record is a
  weak signal ("HubSpot signal found") and keeps "Uses HubSpot" open; finding
  Salesforce does not rule HubSpot out.
- **CSV export** with the source of every value.
- **AI writes, rules decide.** The model only drafts one opening line, and
  only when there is evidence to write about. Its output is checked by rules:
  company name spelled right, and every number must match a fact in the row
  in value and meaning ("20 offices" fails against "200 employees"). Any
  failure falls back to a template, and the cell says so.

## Stack

Cloudflare Workers, Workers AI, TypeScript, Vitest. Plain HTML, CSS and ES
modules, no build step. Nothing is stored.

## Run it

```bash
npm install
npm run dev
npm run test:run && npm run typecheck && npm run lint
```
