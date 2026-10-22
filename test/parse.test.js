import { describe, expect, it } from 'vitest';
import { CellError, date, id, paise } from '../src/server/lib/parse.js';
import { parseSku } from '../src/server/catalog/sku.js';

describe('money', () => {
  it('parses rupee strings to integer paise', () => {
    expect(paise('₹1,234.50')).toBe(123450);
    expect(paise('Rs. 99')).toBe(9900);
    expect(paise('(12.00)')).toBe(-1200);
    expect(paise('-0.01')).toBe(-1);
    expect(paise(1.005)).toBe(101);
    expect(paise(0.1 + 0.2)).toBe(30);
    expect(paise('')).toBeNull();
  });
  it('refuses what is not an amount', () => {
    expect(() => paise('abc')).toThrow(CellError);
    expect(() => paise('12,34x')).toThrow(CellError);
  });
});

describe('dates', () => {
  it('reads Indian day-first dates and Excel serials', () => {
    expect(date('05/10/2026')).toBe('2026-10-05');
    expect(date('05.10.2026')).toBe('2026-10-05');
    expect(date('5-10-26')).toBe('2026-10-05');
    expect(date('2026-10-05T10:20:00')).toBe('2026-10-05');
    expect(date('05 Oct 2026')).toBe('2026-10-05');
    expect(date('Oct 5, 2026')).toBe('2026-10-05');
    expect(date(46300)).toBe('2026-10-05');
  });
  it('refuses impossible dates instead of rolling them over', () => {
    expect(() => date('31/02/2026')).toThrow(CellError);
    expect(() => date('008664172757')).toThrow(CellError);
  });
});

describe('ids', () => {
  it('keeps IDs as text and refuses Excel scientific notation', () => {
    expect(id('008664172757204845_1')).toBe('008664172757204845_1');
    expect(id('OD147007418529630033')).toBe('OD147007418529630033');
    expect(() => id('1.15993E+17')).toThrow(/scientific notation/);
  });
});

describe('SKU codes', () => {
  it('ignores the listing number after the last slash', () => {
    for (const sku of ['TC_BT/1.1', 'TC_BT/7', 'TC_BT/40365', ' tc_bt/12 ']) expect(parseSku(sku).code).toBe('TC_BT');
    expect(parseSku('TC_60*90_BT/66412').code).toBe('TC_60*90_BT');
    expect(parseSku('WH_MFO').code).toBe('WH_MFO');
    expect(parseSku('TC_NW_Frill/12').code).toBe('TC_NW_FRILL');
  });
});
