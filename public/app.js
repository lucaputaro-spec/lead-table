// Verhalten der Seite. Alles, was vom Server oder vom Besucher kommt, wird
// als reiner Text eingesetzt (nie als HTML), damit fremde Webseiten-Inhalte
// hier keinen Code einschleusen können.

import { findLateDuplicates, parseList } from "./lib/list.js";
import { judge, rank, RULES } from "./lib/icp.js";
import { toCsv } from "./lib/csv.js";

const $ = (sel) => document.querySelector(sel);

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

// Beispiel-Liste: öffentliche Firmen-Websites, keine Kunden. Absichtlich mit
// unordentlicher Schreibweise, einer Dublette und einem kaputten Eintrag.
const EXAMPLE = [
  "hubspot.com",
  "https://www.stripe.com/",
  "pipedrive.com",
  "n8n.io",
  "notion.so",
  "zapier.com",
  "intercom.com",
  "STRIPE.com",
  "mailchimp.com",
  "personio.de",
  "webflow.com",
  "calendly.com",
  "typeform.com",
  "gitlab.com",
  "atlassian.com",
  "miro.com",
  "notion.com",
  "lemlist.com",
  "airtable.com",
  "not a website",
].join("\n");

const COLS = [
  { key: "company", label: "Company", order: ["Homepage name tag", "Wikidata", "Homepage title", "Domain name"] },
  { key: "mail", label: "Email provider", order: ["MX record", "SPF record", "MX host as-is"] },
  { key: "crm", label: "CRM", order: ["Homepage scripts", "SPF record", "DNS verification"] },
  { key: "motion", label: "Sales motion", order: ["Homepage buttons", "Pricing page"] },
  { key: "country", label: "Country", order: ["Wikidata", "Country domain"] },
  { key: "employees", label: "Employees", order: ["Wikidata"] },
  { key: "linkedin", label: "LinkedIn", order: ["Homepage link", "Wikidata"] },
  { key: "hook", label: "Opening line", order: ["Workers AI", "Template"] },
];
const NONE = { crm: "None visible", motion: "Unclear", country: "Unknown", employees: "No public source", linkedin: "Not found" };
const PARALLEL = 3;

const state = {
  rows: [],
  running: false,
  runId: 0,
  sel: null,
  autoSel: true,
  active: new Map(),
  country: "",
  dropped: 0,
};

/* ---------- Server ---------- */

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(path, body, onWait) {
  for (let attempt = 0; attempt < 5; attempt++) {
    let res;
    try {
      res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    } catch {
      throw new Error("No connection to the server.");
    }
    // Bremse erreicht: kurz warten und dieselbe Zeile noch einmal versuchen.
    if (res.status === 429) {
      onWait?.();
      await pause(12_000);
      continue;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "The server could not handle this row.");
    return data;
  }
  throw new Error("Rate limit still active. Run the list again in a minute.");
}

/* ---------- Ablauf ---------- */

async function runList(text) {
  const { rows, dropped } = parseList(text);
  const runId = ++state.runId;
  state.dropped = dropped;
  state.sel = null;
  state.autoSel = true;
  state.rows = rows.map((r) => ({
    ...r,
    phase: !r.domain ? "invalid" : r.duplicateOf ? "skipped" : "waiting",
    data: null,
    error: "",
    note: "",
    hook: null,
    hookPhase: "waiting",
    late: null,
  }));
  state.running = true;
  render();

  const queue = state.rows.filter((r) => r.phase === "waiting");
  const worker = async () => {
    for (let row = queue.shift(); row; row = queue.shift()) {
      if (runId !== state.runId) return;
      await enrichRow(row, runId);
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  if (runId !== state.runId) return;
  state.running = false;
  render();
}

async function enrichRow(row, runId) {
  row.phase = "running";
  render();
  try {
    row.data = await post("/api/enrich", { domain: row.domain }, () => {
      row.note = "Paused by the rate limit, retrying in a moment";
      render();
    });
    row.note = "";
  } catch (err) {
    row.error = err.message;
  }
  if (runId !== state.runId) return;
  row.phase = "done";
  row.fresh = true;
  markLateDuplicates();
  render();

  const c = row.data?.cells;
  if (!c || row.late) {
    row.hookPhase = "none";
    render();
    return;
  }
  row.hookPhase = "running";
  render();
  const motionStep = c.motion.trail.find((s) => s.status === "hit");
  try {
    row.hook = await post("/api/hook", {
      domain: row.domain,
      company: c.company.value || "",
      about: row.data.about,
      motion: c.motion.value || "",
      motionEvidence: motionStep ? motionStep.note.replace(/^.*?: |^button text /, "") : "",
      crm: (c.crm.tags ?? []).join(", "),
      mail: c.mail.value || "",
      employees: c.employees.number ?? null,
    });
  } catch (err) {
    row.hook = { text: "", source: "", note: err.message };
  }
  if (runId !== state.runId) return;
  row.hookPhase = "done";
  render();
}

function markLateDuplicates() {
  const done = state.rows.filter((r) => r.data?.cells);
  const dupes = findLateDuplicates(done.map((r) => ({ n: r.n, domain: r.domain, finalHost: r.data.finalHost, wikidataId: r.data.wikidataId })));
  for (const r of done) r.late = dupes.get(r.n) ?? null;
}

/* ---------- Zielkunden-Regeln ---------- */

function factsOf(row) {
  const c = row.data?.cells;
  if (!c) return null;
  return {
    crm: c.crm.tags ?? [],
    crmWeak: c.crm.weak ?? [],
    motion: c.motion.value,
    mail: c.mail.value,
    country: c.country.value,
    employees: c.employees.number ?? null,
  };
}

function activeRules() {
  return [...state.active.entries()].map(([id]) => (id === "country" ? { id, option: state.country } : { id }));
}

function fitOf(row) {
  const facts = factsOf(row);
  if (!facts || row.late || !state.active.size) return null;
  return judge(facts, activeRules());
}

// Die Schalter werden einmal gebaut. Bei Updates ändern sich nur die
// Länder im Auswahlfeld, sonst würde ein offenes Auswahlfeld zuklappen.
let countrySelect = null;

function buildRules() {
  $("#rules").replaceChildren(
    ...RULES.map((rule) => {
      const input = h("input", { type: "checkbox" });
      input.checked = state.active.has(rule.id);
      input.addEventListener("change", () => {
        if (input.checked) state.active.set(rule.id, "");
        else state.active.delete(rule.id);
        render();
      });
      if (rule.id !== "country") return h("label", { class: "pill" }, input, rule.label);
      countrySelect = h("select", { "aria-label": "Country" });
      countrySelect.addEventListener("change", () => {
        state.country = countrySelect.value;
        render();
      });
      return h("label", { class: "pill" }, input, rule.label, countrySelect);
    }),
  );
}

function updateCountries() {
  const found = state.rows.map((r) => r.data?.cells?.country.value).filter(Boolean);
  if (!state.country) state.country = "Germany";
  const options = [...new Set([state.country, "Germany", "United States", ...found])].sort();
  const now = [...countrySelect.options].map((o) => o.value);
  if (now.join("|") === options.join("|") || document.activeElement === countrySelect) return;
  countrySelect.replaceChildren(...options.map((c) => h("option", { value: c }, c)));
  countrySelect.value = state.country;
}

/* ---------- Tabelle ---------- */

function chipFor(cell) {
  if (!cell.step) return h("span", { class: "chip s0", title: "No source had an answer" }, "–");
  return h(
    "span",
    { class: `chip ${cell.step === 1 ? "s1" : "s2"}`, title: `Step ${cell.step}: ${cell.source}` },
    String(cell.step),
  );
}

function shortLinkedin(url) {
  return url.replace(/^https:\/\/www\./, "");
}

function select(n, col) {
  state.sel = { n, col };
  state.autoSel = false;
  render();
}

function valueCell(row, col) {
  if (row.phase === "invalid" || row.phase === "skipped" || row.late && col.key === "hook") return h("td", {}, h("span", { class: "waiting" }, "—"));
  if (row.phase === "waiting") return h("td", {}, h("span", { class: "waiting" }, "·"));
  if (row.phase === "running") return h("td", {}, h("span", { class: "asking" }, "asking…"));
  const sel = state.sel && state.sel.n === row.n && state.sel.col === col.key;

  if (col.key === "hook") {
    if (row.hookPhase === "running") return h("td", { class: "hook" }, h("span", { class: "asking" }, "writing…"));
    if (row.hookPhase !== "done" || !row.hook?.text) return h("td", { class: "hook" }, h("span", { class: "waiting" }, row.hook?.note || "—"));
    const ai = row.hook.source === "Workers AI";
    return h(
      "td",
      { class: "hook" },
      h(
        "button",
        { class: `cell${sel ? " sel" : ""}`, type: "button", onclick: () => select(row.n, col.key) },
        h("span", { class: `chip ${ai ? "ai" : "tpl"}`, title: row.hook.source }, ai ? "AI" : "T"),
        h("span", { class: "v" }, row.hook.text),
      ),
    );
  }

  const cell = row.data?.cells?.[col.key];
  if (!cell) return h("td", {}, h("span", { class: "waiting" }, "—"));
  const text = cell.value === null ? h("span", { class: "none" }, NONE[col.key] || "Not found") : col.key === "linkedin" ? shortLinkedin(cell.value) : cell.value;
  return h(
    "td",
    {},
    h(
      "button",
      { class: `cell${sel ? " sel" : ""}`, type: "button", onclick: () => select(row.n, col.key), "aria-label": `${col.label} for row ${row.n}: details` },
      chipFor(cell),
      h("span", { class: "v" }, text),
    ),
  );
}

function statusCell(row) {
  let tag;
  let note = "";
  if (row.phase === "invalid") [tag, note] = [h("span", { class: "tag bad" }, "Not a website"), `Could not read “${row.input}” as a web address.`];
  else if (row.phase === "skipped") [tag, note] = [h("span", { class: "tag dup" }, `Duplicate of #${row.duplicateOf}`), "Same site, other spelling. Skipped, no lookups spent."];
  else if (row.phase === "waiting") tag = h("span", { class: "waiting" }, "In line");
  else if (row.phase === "running") tag = h("span", { class: "asking" }, row.note || "Asking sources…");
  else if (row.error) [tag, note] = [h("span", { class: "tag bad" }, "Lookup failed"), row.error];
  else if (row.late) [tag, note] = [h("span", { class: "tag dup" }, `Likely duplicate of #${row.late.of}`), `${row.late.why[0].toUpperCase()}${row.late.why.slice(1)}.`];
  else if (row.data.status === "broken") [tag, note] = [h("span", { class: "tag bad" }, "Broken"), row.data.problems.join(" ")];
  else if (row.data.status === "partial") [tag, note] = [h("span", { class: "tag warn" }, "Partly filled"), row.data.problems.join(" ")];
  else [tag, note] = [h("span", { class: "tag ok" }, "Clean"), `${(row.data.ms / 1000).toFixed(1)} s`];
  return h("td", { class: "status" }, tag, note && h("small", {}, note));
}

function fitCell(row) {
  if (!row.fit) {
    const why = !state.active.size ? "Switch on a rule" : row.late ? "Duplicate, not ranked" : row.data?.cells ? "" : "No data";
    return h("td", { class: "fit" }, h("span", { class: "waiting" }, why || "—"));
  }
  return h(
    "td",
    { class: "fit" },
    h("span", { class: "score" }, `${row.fit.hits}/${row.fit.total}`),
    h(
      "ul",
      { class: "verdicts" },
      row.fit.verdicts.map((v) => h("li", { class: v.ok === true ? "yes" : v.ok === false ? "no" : "unk" }, `${v.label}: ${v.why}`)),
    ),
  );
}

function renderHead() {
  $("#thead").replaceChildren(
    h(
      "tr",
      {},
      h("th", {}, "#"),
      h("th", {}, "Website", h("small", {}, "as pasted")),
      COLS.map((c) => h("th", { scope: "col" }, c.label, h("small", {}, c.order.join(" → ")))),
      h("th", {}, "Fit", h("small", {}, "rules above")),
      h("th", {}, "Status", h("small", {}, "clean-up")),
    ),
  );
}

function renderBody() {
  for (const r of state.rows) r.fit = fitOf(r);
  const ordered = state.active.size ? rank(state.rows) : state.rows;
  const body = ordered.map((row) => {
    const tr = h(
      "tr",
      { class: [row.fresh ? "fresh" : "", row.phase === "skipped" || row.phase === "invalid" || row.late ? "dim" : ""].join(" ").trim() || null },
      h("td", { class: "n" }, String(row.n)),
      h("td", { class: "site" }, row.domain && row.domain !== row.input ? [row.domain, h("br"), h("s", {}, row.input)] : row.input),
      COLS.map((c) => valueCell(row, c)),
      fitCell(row),
      statusCell(row),
    );
    row.fresh = false;
    return tr;
  });
  $("#tbody").replaceChildren(...body);
}

function renderProgress() {
  const total = state.rows.length;
  const finished = state.rows.filter((r) => r.phase !== "waiting" && r.phase !== "running" && (r.hookPhase !== "running")).length;
  const counts = {
    clean: state.rows.filter((r) => r.data?.status === "ok" && !r.late).length,
    partial: state.rows.filter((r) => r.data?.status === "partial" && !r.late).length,
    dupes: state.rows.filter((r) => r.phase === "skipped" || r.late).length,
    broken: state.rows.filter((r) => r.phase === "invalid" || r.data?.status === "broken" || r.error).length,
  };
  const head = state.running ? `Enriching… ${finished} of ${total} rows` : total ? `Done: ${total} rows` : "No list yet.";
  const tail = total
    ? ` · ${counts.clean} clean, ${counts.partial} partly filled, ${counts.dupes} duplicates, ${counts.broken} broken${state.dropped ? ` · ${state.dropped} lines over the limit of 25 were left out` : ""}`
    : "";
  $("#progress-text").textContent = head + tail;
  $("#progress-bar").style.width = total ? `${Math.round((finished / total) * 100)}%` : "0%";
  $("#run").disabled = state.running;
  $("#export").disabled = !state.rows.some((r) => r.data);
}

/* ---------- Detailansicht einer Zelle ---------- */

const STATUS_WORD = { hit: "Answered", miss: "Nothing", error: "Failed", skipped: "Not asked" };

function trailOf(row, key) {
  if (key !== "hook") return row.data?.cells?.[key]?.trail ?? null;
  if (!row.hook) return null;
  const ai = row.hook.source === "Workers AI";
  return [
    { source: "Workers AI", status: ai ? "hit" : "error", note: ai ? row.hook.note : row.hook.note, ms: 0 },
    { source: "Template", status: ai ? "skipped" : "hit", note: ai ? "not needed" : "fixed sentence built from the facts in this row", ms: 0 },
  ];
}

function autoSelect() {
  if (!state.autoSel) return;
  // Zeigt von selbst die erste Zelle, in der eine Ersatzquelle einspringen musste.
  for (const row of state.rows) {
    for (const c of COLS) {
      if (c.key !== "hook" && (row.data?.cells?.[c.key]?.step ?? 0) >= 2) {
        state.sel = { n: row.n, col: c.key };
        return;
      }
    }
  }
}

function renderInspect() {
  const box = $("#inspect");
  const row = state.sel && state.rows.find((r) => r.n === state.sel.n);
  const col = state.sel && COLS.find((c) => c.key === state.sel.col);
  const trail = row && col && trailOf(row, col.key);
  if (!trail) {
    box.replaceChildren(h("p", { class: "empty" }, "Click any filled cell to see its waterfall: which sources were asked, in what order, what each one said and how long it took."));
    return;
  }
  const answered = trail.find((s) => s.status === "hit");
  const value = col.key === "hook" ? row.hook.text : row.data.cells[col.key].value;
  const first = trail.indexOf(answered);
  const sub = !answered
    ? "No source had an answer, so the cell stays empty instead of guessing."
    : first === 0
      ? "The first source answered, so the others were never asked."
      : `Source ${first + 1} answered after ${first === 1 ? "the first one" : `the first ${first}`} came back empty. That is the waterfall at work.`;
  box.replaceChildren(
    ...[
    h("h3", {}, `${col.label} · row ${row.n} · ${row.domain}`),
    h("p", { class: "sub" }, state.autoSel ? `Picked for you: a cell where a fallback was needed. ${sub}` : sub),
    h(
      "ol",
      { class: "trail" },
      trail.map((s, i) =>
        h(
          "li",
          { class: s.status },
          h("b", {}, String(i + 1)),
          h("span", { class: "src" }, s.source),
          h("span", { class: "what" }, h("em", {}, STATUS_WORD[s.status]), s.note),
          h("time", {}, s.status === "skipped" || !s.ms ? "" : `${s.ms} ms`),
        ),
      ),
    ),
    value && col.key === "linkedin" ? h("p", { class: "sub" }, h("a", { href: value, target: "_blank", rel: "noopener noreferrer" }, value)) : null,
    ].filter(Boolean),
  );
}

/* ---------- Export ---------- */

function exportCsv() {
  const keys = ["company", "mail", "crm", "motion", "country", "employees", "linkedin"];
  const header = ["row", "input", "domain", "status", "status_note", ...keys.flatMap((k) => [k, `${k}_source`]), "about", "opening_line", "opening_line_source", "fit", "fit_reasons"];
  const rows = (state.active.size ? rank(state.rows) : state.rows).map((r) => {
    const c = r.data?.cells;
    const status = r.phase === "invalid" ? "invalid" : r.phase === "skipped" ? `duplicate of #${r.duplicateOf}` : r.late ? `likely duplicate of #${r.late.of}` : r.error ? "failed" : r.data?.status ?? "";
    return [
      r.n,
      r.input,
      r.domain ?? "",
      status,
      r.late?.why ?? r.error ?? r.data?.problems.join(" ") ?? "",
      ...keys.flatMap((k) => [c?.[k]?.value ?? "", c?.[k]?.source ?? ""]),
      r.data?.about ?? "",
      r.hook?.text ?? "",
      r.hook?.source ?? "",
      r.fit ? `${r.fit.hits}/${r.fit.total}` : "",
      r.fit ? r.fit.verdicts.map((v) => `${v.ok === true ? "yes" : v.ok === false ? "no" : "unknown"}: ${v.label} (${v.why})`).join("; ") : "",
    ];
  });
  const blob = new Blob(["﻿" + toCsv(header, rows)], { type: "text/csv;charset=utf-8" });
  const a = h("a", { href: URL.createObjectURL(blob), download: "lead-table.csv" });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ---------- Zusammenbau ---------- */

let queued = false;
function render() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    autoSelect();
    updateCountries();
    if (state.rows.length) renderBody();
    renderProgress();
    renderInspect();
  });
}

$("#example").addEventListener("click", () => {
  $("#list").value = EXAMPLE;
  updateNote();
  $("#list").focus();
});
// Abkürzung aus dem Kopf der Seite: Beispiel laden und sofort starten, ohne
// dass man erst die Erklärung des Wasserfalls lesen muss.
$("#try-example").addEventListener("click", () => {
  $("#list").value = EXAMPLE;
  updateNote();
  $("#list-form").requestSubmit();
});
$("#list").addEventListener("input", updateNote);
function updateNote() {
  const { rows, dropped } = parseList($("#list").value);
  $("#list-note").textContent = rows.length ? `${rows.length} entries${dropped ? `, ${dropped} over the limit` : ""}` : "";
}
$("#list-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("#list").value;
  if (!parseList(text).rows.length) {
    $("#list-note").textContent = "Paste at least one website first, or load the example list.";
    return;
  }
  runList(text);
  document.querySelector(".work").scrollIntoView({ behavior: "smooth", block: "start" });
});
$("#export").addEventListener("click", exportCsv);

buildRules();
renderHead();
render();
