/**
 * Example cost sheet, used until a costs.local.js exists. Copy this file to
 * costs.local.js (git ignores it) and put in your own purchase prices.
 *
 * Rupees per unit as sold, keyed by SKU code (the part before the last "/").
 * A pack of 4 costs four pieces. Packaging is charged separately per packet.
 */

// Codes that share a price can be generated, e.g. every organiser design in three pack sizes.
const DESIGNS = ['MFO', 'BF'];
const PACK_COST = { 1: 45, 2: 90, 4: 180 };

function organiserCosts() {
  const out = {};
  for (const d of DESIGNS) {
    out[`WH_1${d}`] = PACK_COST[1];
    out[`WH_${d}`] = PACK_COST[2];
    out[`WH_4${d}`] = PACK_COST[4];
  }
  return out;
}

export const SEED_COSTS = {
  ...organiserCosts(),
  TC_BT: 120,
  'TC_60*90_BT': 240,
  BM_WT: 150,
};
