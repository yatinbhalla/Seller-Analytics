import { readSheets } from './table.js';
import { readPdfPages } from './pdf.js';
import flipkartInvoices from './flipkart/invoices.js';
import flipkartSettlement from './flipkart/settlement.js';
import flipkartReturns from './flipkart/returns.js';
import flipkartCancellations from './flipkart/cancellations.js';
import flipkartOrders from './flipkart/orders.js';
import meeshoInvoices from './meesho/invoices.js';
import meeshoPayments from './meesho/payments.js';
import meeshoReturns from './meesho/returns.js';
import meeshoOrders from './meesho/orders.js';

export const IMPORTERS = [
  flipkartInvoices, flipkartSettlement, flipkartReturns, flipkartCancellations, flipkartOrders,
  meeshoInvoices, meeshoPayments, meeshoReturns, meeshoOrders,
];

/**
 * Work out what a file is from its contents — never from its name, which the seller
 * may have changed and the marketplaces change between downloads.
 *
 * Returns { importer, input } for a recognised file, or throws with a message the
 * Import page shows as-is: either "looks like X but is missing columns …" or the
 * headers it did find, so a renamed column is obvious.
 */
export async function detectFile(buffer, fileName) {
  const isPdf = buffer.subarray(0, 5).toString('latin1') === '%PDF-';
  let input;
  try {
    input = isPdf ? { pages: await readPdfPages(buffer) } : { sheets: readSheets(buffer, fileName) };
  } catch (err) {
    throw new Error(`Could not open ${fileName}: ${err.message}. Is the file complete and not password-protected?`);
  }

  const candidates = [];
  for (const importer of IMPORTERS) {
    if ((importer.accepts === 'pdf') !== isPdf) continue;
    const d = importer.detect(input);
    if (d) candidates.push({ importer, detected: d });
  }
  const matches = candidates.filter((c) => c.detected.status === 'match').sort((a, b) => b.detected.score - a.detected.score);
  if (matches.length) return { importer: matches[0].importer, detected: matches[0].detected, input };

  const near = candidates.filter((c) => c.detected.status === 'near').sort((a, b) => b.detected.score - a.detected.score)[0];
  if (near) {
    const names = near.detected.missing.map((f) => near.importer.spec.columns[f][0]);
    throw new Error(
      `${fileName} looks like a ${near.importer.label} but is missing column(s): ${names.join(', ')}. ` +
        'The marketplace may have renamed them — nothing was imported.',
    );
  }
  if (isPdf) {
    const empty = input.pages.every((p) => !p.lines.length);
    throw new Error(
      empty
        ? `${fileName} has no readable text (a scanned image?). Download the invoice PDF again from the seller panel.`
        : `${fileName} is not a Flipkart or Meesho invoice PDF this app recognises. Nothing was imported.`,
    );
  }
  const headers = (input.sheets[0]?.rows || []).slice(0, 3).flat().filter(Boolean).slice(0, 15);
  throw new Error(`${fileName} is not a report this app recognises. First headers seen: ${headers.join(' | ') || '(none)'}.`);
}
