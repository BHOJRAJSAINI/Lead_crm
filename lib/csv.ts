/** CSV helpers: escaping identical to Code.gs + spreadsheet formula-injection guard. */
export function csvEscape(cell: any): string {
  let s = cell === null || cell === undefined ? '' : String(cell);
  // Guard Excel/Sheets formula injection: neutralize leading =, +, -, @
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}

export function toCsv(rows: any[][]): string {
  return rows.map((r) => r.map(csvEscape).join(',')).join('\n');
}
