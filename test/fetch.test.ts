import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchPage } from "../src/guard";

const html = () => new Response("<html>ok</html>", { headers: { "content-type": "text/html" } });
const redirect = (to: string) => new Response(null, { status: 302, headers: { location: to } });

afterEach(() => vi.unstubAllGlobals());

describe("fetchPage redirects", () => {
  it("follows a redirect to another public page and reports where it landed", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(url);
      return calls.length === 1 ? redirect("https://www.notion.com/en/") : html();
    }));
    expect(await fetchPage("https://notion.so/")).toMatchObject({ ok: true, finalHost: "notion.com" });
    expect(calls).toEqual(["https://notion.so/", "https://www.notion.com/en/"]);
  });

  it("refuses redirects the input check would have refused", async () => {
    for (const target of ["https://other.lucaputaro.workers.dev/", "http://acme.io/", "https://acme.io:8443/", "https://127.0.0.1/", "https://intra.local/"]) {
      const calls: string[] = [];
      vi.stubGlobal("fetch", vi.fn(async (url: string) => {
        calls.push(url);
        return calls.length === 1 ? redirect(target) : html();
      }));
      expect(await fetchPage("https://acme.io/")).toMatchObject({ ok: false });
      expect(calls).toHaveLength(1);
    }
  });

  it("refuses a disallowed start address without fetching", async () => {
    const f = vi.fn(async () => html());
    vi.stubGlobal("fetch", f);
    expect(await fetchPage("http://acme.io/")).toMatchObject({ ok: false });
    expect(f).not.toHaveBeenCalled();
  });

  it("gives up after too many redirects", async () => {
    let n = 0;
    vi.stubGlobal("fetch", vi.fn(async () => redirect(`https://acme.io/${++n}`)));
    expect(await fetchPage("https://acme.io/")).toMatchObject({ ok: false, reason: "redirects too often" });
    expect(n).toBeLessThanOrEqual(4);
  });
});
