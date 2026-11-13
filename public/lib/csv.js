// CSV-Export. Excel und Google Sheets lesen das so ein. Zellen, die mit
// = + - @ beginnen, bekommen ein Hochkomma davor, sonst würde eine fremde
// Website-Beschreibung beim Öffnen in Excel als Formel ausgeführt.

/**
 * @param {unknown} value
 * @returns {string}
 */
export function csvCell(value) {
  let s = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * @param {string[]} header
 * @param {unknown[][]} rows
 * @returns {string}
 */
export function toCsv(header, rows) {
  return [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
