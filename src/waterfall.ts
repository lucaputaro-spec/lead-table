// Der Wasserfall: eine Spalte fragt ihre Quellen nacheinander. Liefert eine
// Quelle nichts, kommt die nächste. Die erste Antwort gewinnt, alle Quellen
// danach werden gar nicht erst gefragt. Bei bezahlten Werkzeugen spart das
// Geld (jede Abfrage kostet), hier spart es Zeit und fremde Server.

export type StepStatus = "hit" | "miss" | "error" | "skipped";

export interface Step {
  source: string;
  status: StepStatus;
  note: string;
  ms: number;
}

export interface Cell {
  value: string | null;
  tags?: string[];
  // Schwache Hinweise: zeigen einen Bezug, belegen aber keinen Einsatz.
  weak?: string[];
  number?: number;
  source: string | null;
  step: number | null;
  trail: Step[];
}

// Was eine Quelle zurückgibt: ein Treffer, oder ein Hinweis, warum nicht.
export type Answer =
  | { hit: true; value: string; tags?: string[]; weak?: string[]; number?: number; note: string }
  | { hit: false; note: string };

export interface Source {
  name: string;
  ask: () => Promise<Answer>;
}

export const miss = (note: string): Answer => ({ hit: false, note });
export const hit = (value: string, note: string, extra: { tags?: string[]; weak?: string[]; number?: number } = {}): Answer => ({
  hit: true,
  value,
  note,
  ...extra,
});

export async function waterfall(sources: Source[], now: () => number = Date.now): Promise<Cell> {
  const trail: Step[] = [];
  let cell: Cell = { value: null, source: null, step: null, trail };
  for (const [i, src] of sources.entries()) {
    if (cell.value !== null) {
      trail.push({ source: src.name, status: "skipped", note: "not asked, an earlier source answered", ms: 0 });
      continue;
    }
    const t = now();
    let answer: Answer;
    let failed = false;
    try {
      answer = await src.ask();
    } catch (err) {
      failed = true;
      answer = miss(err instanceof Error ? err.message : "source failed");
    }
    const ms = now() - t;
    if (answer.hit) {
      trail.push({ source: src.name, status: "hit", note: answer.note, ms });
      cell = { value: answer.value, source: src.name, step: i + 1, trail };
      if (answer.tags) cell.tags = answer.tags;
      if (answer.weak) cell.weak = answer.weak;
      if (answer.number !== undefined) cell.number = answer.number;
    } else {
      trail.push({ source: src.name, status: failed ? "error" : "miss", note: answer.note, ms });
    }
  }
  return cell;
}

// Eine Quelle, die mehrere Spalten brauchen (z. B. die Startseite), wird nur
// einmal abgerufen. Wer sie zuerst braucht, löst den Abruf aus.
export function once<T>(load: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | null = null;
  return () => (p ??= load());
}
