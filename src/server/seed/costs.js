import fs from 'fs';

/**
 * Seed data for the catalog: cost prices, code aliases, and codes that no lister
 * path describes.
 *
 * Costs are rupees per unit as sold — a 4-pack organiser costs four pieces. Packaging
 * (₹7 per packet) is NOT in them; it is charged separately per shipment, see
 * settings.packaging_paise.
 *
 * The real cost sheet is business data, so it lives in costs.local.js, which git
 * ignores. A fresh clone uses costs.example.js until you copy it to costs.local.js
 * and fill in your own prices. Either way costs can be changed later in Settings.
 *
 * Seeded with effective_from 2000-01-01 so every historical order finds a cost. A
 * later change in Settings adds a new row from its own date; seeding never
 * overwrites a cost the seller has already set.
 */

export const COST_EFFECTIVE_FROM = '2000-01-01';

const local = new URL('./costs.local.js', import.meta.url);

/** Rupees per unit, keyed by SKU code. */
export const { SEED_COSTS } = await import(fs.existsSync(local) ? local.href : './costs.example.js');


/**
 * Old or misspelt codes → their current code. `confirmed: false` ones were assumed
 * and show on the SKU Mapping screen for a yes or no.
 */
export const SEED_ALIASES = [
  { alias: 'TC_NB', code: 'TC_NBC', confirmed: true, note: 'Seller: TC_NB = TC_NBC' },
  { alias: 'TC_NOWP', code: 'TC_L_NOWP', confirmed: false, note: 'Assumed: old code for the off-white crochet net cover' },
  { alias: 'TC_NW_FRILL', code: 'TC_NWT_FRILL', confirmed: false, note: 'Assumed: old spelling of the white fringe cover' },
];

/**
 * Codes that are in the SKU ledgers or the cost sheet but in no lister path. Each
 * still needs a product to roll up under.
 *   product   — slug of an existing product to join, or a new one to create
 *   variant   — the variant label inside that product
 *   shareWith — a code whose stock shelf this one takes pieces from (another pack
 *               size of the same piece); without it the code gets a shelf of its own
 */
export const SEED_EXTRA_CODES = [
  { code: 'WH_P1', product: 'wall-hanging-organizer-mauve', variant: 'Pack of 1 - 10 x 30 inch', packOf: 1, shareWith: 'WH_P', note: 'Old Mauve 1-pack code' },
  { code: 'WH_P4', product: 'wall-hanging-organizer-mauve', variant: 'Pack of 4 - 10 x 30 inch', packOf: 4, shareWith: 'WH_P', note: 'Old Mauve 4-pack code' },
  { code: 'TC_NBLUC', product: 'net-table-cover-tc-nbluc', name: 'Net Table Cover (TC_NBLUC — name to fill)', category: 'Table Cover', variant: '4 Seater - 40x60 inch', packOf: 1 },
  { code: 'TC_NWT', product: 'net-table-cover-tc-nwt', name: 'Net Table Cover (TC_NWT — name to fill)', category: 'Table Cover', variant: '4 Seater - 40x60 inch', packOf: 1 },
  { code: 'TC_NPR', product: 'net-table-cover-tc-npr', name: 'Net Table Cover (TC_NPR — name to fill)', category: 'Table Cover', variant: '4 Seater - 40x60 inch', packOf: 1 },
  // Names below are the product titles these codes carry in the Meesho and Flipkart files.
  { code: 'SL_5_PF', product: 'shelf-liner-pink-floral', name: 'Shelf Liner / Kitchen Mat (pink floral, cream base)', category: 'Shelf Liner', variant: 'Single', packOf: 1 },
  // One grey daisy print in two roll lengths: one product, two shelves.
  { code: 'SL_GRF', product: 'shelf-liner-grey-daisy', name: 'Shelf Liner Roll (grey daisy print, 45 cm wide)', category: 'Shelf Liner', variant: '10 m x 45 cm', packOf: 1 },
  { code: 'SL_5_GRF', product: 'shelf-liner-grey-daisy', name: 'Shelf Liner Roll (grey daisy print, 45 cm wide)', category: 'Shelf Liner', variant: '5 m x 45 cm', packOf: 1 },
  { code: 'WH_NG', product: 'wall-hanging-organizer-grey-ng', name: 'Wall Hanging Organizer (grey quilted, 6 pockets, set of 2)', category: 'Hanging Organizers', variant: 'Pack of 2', packOf: 2 },
  { code: 'TC_NP', product: 'net-table-cover-pink-floral', name: 'Net Table Cover (pink floral printed, 40x60 in)', category: 'Table Cover', variant: '4 Seater - 40x60 inch', packOf: 1 },
  { code: 'TC_NBG', product: 'net-table-cover-beige-lace-print', name: 'Net Table Cover (beige floral print lace, 40x60 in)', category: 'Table Cover', variant: '4 Seater - 40x60 inch', packOf: 1 },
  { code: 'PROBE', product: 'bath-towel-microfiber-300gsm', name: 'Bath Towel (microfiber, 300 GSM)', category: 'Bath Towels', variant: 'Single', packOf: 1 },
];
