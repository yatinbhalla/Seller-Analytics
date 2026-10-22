import * as XLSX from 'xlsx';
import { CellError, headerKey, isBlank } from '../lib/parse.js';

/**
 * Read every sheet of an Excel or CSV file into rows of raw cell values.
 *
 * - CSV is read with raw: true so "123456789012345678_1" and long digit strings stay
 *   text — letting SheetJS turn them into numbers would drop digits.
 * - Dates come back as Date objects (cellDates), numbers as numbers, text as text.
 *   The cell parsers in lib/parse.js decide what each one means per column.
 */
export function readSheets(buffer, fileName = '') {
  const isCsv = /\.(csv|txt)$/i.test(fileName);
  // Marketplace CSVs are UTF-8. Handed over as bytes, SheetJS reads them as Latin-1
  // and "–" becomes "â€“", so CSV text is decoded first (and its BOM dropped).
  const wb = isCsv
    ? XLSX.read(buffer.toString('utf8').replace(/^﻿/, ''), { type: 'string', cellDates: true, raw: true, dense: true })
    : XLSX.read(buffer, { type: 'buffer', cellDates: true, dense: true });
  return wb.SheetNames.map((name) => ({ name, rows: sheetRows(wb.Sheets[name]) }));
}

function sheetRows(ws) {
  const data = ws['!data'] || [];
  const out = [];
  for (let r = 0; r < data.length; r++) {
    const row = data[r] || [];
    out.push(row.map((cell) => (cell ? cell.v : null)));
  }
  return out;
}

/**
 * Find the table a profile describes, anywhere in the first 20 rows of any sheet.
 *
 * Marketplace exports often put a title or grouped headers above the real header row
 * (Meesho's payment file does), so the header is searched for rather than assumed to
 * be row 1. A table is found only when EVERY required column is present; a file that
 * is missing one is refused with the list of what was missing, never half-read.
 *
 * spec.columns: { field: ['Header text', 'Alternative header', …] }
 * spec.required: [field, …]
 * spec.sheet: optional RegExp the sheet name must match
 */
export function findTable(sheets, spec) {
  const aliases = Object.entries(spec.columns).map(([field, names]) => [field, names.map(headerKey)]);
  let best = null;
  for (const sheet of sheets) {
    if (spec.sheet && !spec.sheet.test(sheet.name)) continue;
    const limit = Math.min(sheet.rows.length, 20);
    for (let r = 0; r < limit; r++) {
      const keys = (sheet.rows[r] || []).map(headerKey);
      const col = {};
      for (const [field, names] of aliases) {
        const idx = keys.findIndex((k) => k && names.includes(k));
        if (idx !== -1) col[field] = idx;
      }
      const missing = spec.required.filter((f) => !(f in col));
      const score = Object.keys(col).length;
      if (!best || missing.length < best.missing.length || (missing.length === best.missing.length && score > best.score)) {
        best = { sheet, headerRow: r, col, missing, score };
      }
    }
  }
  return best;
}

/**
 * Turn each data row below the header into a payload, collecting failures.
 *
 * rowFn(get, rowNo) returns a payload, null to skip the row (a sub-total or a blank
 * spacer), or throws a CellError, which quarantines the row with its reason.
 */
export function mapRows(table, rowFn) {
  const rows = [];
  const rejected = [];
  let skipped = 0;
  const { sheet, headerRow, col } = table;
  for (let r = headerRow + 1; r < sheet.rows.length; r++) {
    const cells = sheet.rows[r] || [];
    if (cells.every(isBlank)) continue;
    // Meesho fills an empty report with one line: "No data is available for these dates."
    const filled = cells.filter((c) => !isBlank(c));
    if (filled.length === 1 && /^no data/i.test(String(filled[0]).trim())) continue;
    const rowNo = r + 1; // 1-based, as Excel shows it
    const get = (field) => (field in col ? cells[col[field]] : undefined);
    try {
      const payload = rowFn(get, rowNo);
      if (payload) rows.push({ rowNo, ...payload });
      else skipped++;
    } catch (err) {
      if (!(err instanceof CellError)) throw err;
      rejected.push({ rowNo, reason: err.message, raw: rawRow(table, cells) });
    }
  }
  return { rows, rejected, skipped };
}

function rawRow(table, cells) {
  const header = table.sheet.rows[table.headerRow] || [];
  const out = {};
  header.forEach((h, i) => {
    if (!isBlank(cells[i])) out[String(h ?? `col${i + 1}`)] = cells[i] instanceof Date ? cells[i].toISOString() : cells[i];
  });
  return out;
}

/** Wrap a parser so its error names the column — "Order Date: not a date". */
export function field(name, parser, value) {
  try {
    return parser(value);
  } catch (err) {
    if (err instanceof CellError) throw new CellError(`${name}: ${err.message}`);
    throw err;
  }
}

/**
 * For descriptive cells that do not carry money or identity (an invoice date on a
 * returns row, a dispatch date): unreadable becomes null instead of rejecting the
 * whole row. Never use it for an amount, an ID or the date a figure is reported on.
 */
export function soft(parser, value) {
  try {
    return parser(value);
  } catch (err) {
    if (err instanceof CellError) return null;
    throw err;
  }
}

export function required(name, value) {
  if (value == null || value === '') throw new CellError(`${name} is empty`);
  return value;
}
