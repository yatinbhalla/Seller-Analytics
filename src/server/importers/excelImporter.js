import { findTable, mapRows } from './table.js';

/**
 * Shared shape of every Excel/CSV importer.
 *
 * An importer declares the columns it needs and a row function; this turns that into
 * detect() and parse(). Keeping the column aliases as data in each importer means
 * that when a marketplace renames a column, the fix is one line in one file.
 *
 * detect() reports three outcomes:
 *   match    — every required column found
 *   near     — most of them found; the file is probably this report in a changed
 *              format, and the missing columns are named in the error
 *   null     — not this report
 */
export function excelImporter(def) {
  return {
    ...def,
    accepts: 'excel',
    detect({ sheets }) {
      const table = findTable(sheets, def.spec);
      if (!table) return null;
      const found = def.spec.required.length - table.missing.length;
      if (table.missing.length === 0) return { status: 'match', score: table.score, table };
      if (found >= Math.ceil(def.spec.required.length * 0.6)) {
        return { status: 'near', score: table.score, table, missing: table.missing };
      }
      return null;
    },
    parse(input, detected, ctx) {
      const { rows, rejected, skipped } = mapRows(detected.table, (get, rowNo) => def.row(get, rowNo, ctx));
      if (def.finish) def.finish(rows);
      const extra = def.extraTables ? def.extraTables(input, ctx) : { rows: [], rejected: [] };
      return { rows: [...rows, ...extra.rows], rejected: [...rejected, ...extra.rejected], skipped };
    },
  };
}
