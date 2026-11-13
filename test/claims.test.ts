import { describe, expect, it } from "vitest";
import { checkHook } from "../src/ai";

// Datensatz: Acme mit 200 Mitarbeitern (aus dem Feld „employees“ bzw. der Beschreibung).
const acme = { company: "Acme", domain: "acme.com", about: "Acme has 200 employees in Germany.", motion: "Sales-led", motionEvidence: '"book a demo"', crm: "", mail: "", employees: 200 };

describe("number claims in the opening line", () => {
  it("rejects 20 when only 200 is in the facts (part of a number)", () => {
    expect(checkHook("Acme has 20 offices, so every demo request needs a fast owner.", acme)).toMatch(/20/);
  });

  it("rejects the right number with the wrong meaning", () => {
    expect(checkHook("Acme has 200 offices, so every demo request needs a fast owner.", acme)).toMatch(/200 offices/);
  });

  it("accepts the right number with the right meaning", () => {
    expect(checkHook("With 200 employees, Acme gets demo requests that need a fast owner.", acme)).toBe("");
  });

  it("uses the structured headcount even when the description has no number", () => {
    const f = { ...acme, about: "Planning software." };
    expect(checkHook("Acme has 200 employees and asks visitors to book a demo.", f)).toBe("");
    expect(checkHook("Acme has 200 customers and asks visitors to book a demo.", f)).toMatch(/200 customers/);
  });

  it("ignores digits that are part of the company name or domain", () => {
    const f = { ...acme, company: "1Password", domain: "1password.com", about: "" };
    expect(checkHook("1Password asks visitors to book a demo, so reply speed matters.", f)).toBe("");
  });
});
