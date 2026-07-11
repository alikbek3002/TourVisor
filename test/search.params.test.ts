import { describe, it, expect } from 'vitest';
import { buildSearchParams } from '../src/services/tourvisor/search.js';

describe('buildSearchParams', () => {
  it('defaults each child age to 7 when not provided', () => {
    const p = buildSearchParams({ country: 'Турция', children: 2 }, '1', '4');
    expect(p.child).toBe(2);
    expect(p.childage1).toBe(7);
    expect(p.childage2).toBe(7);
    expect(p.childage3).toBeUndefined();
  });

  it('uses provided ages and caps children at 3', () => {
    const p = buildSearchParams(
      { country: 'Турция', children: 5, childrenAges: [3, 10, 14, 16, 17] },
      '1',
      '4',
    );
    expect(p.child).toBe(3);
    expect(p.childage1).toBe(3);
    expect(p.childage2).toBe(10);
    expect(p.childage3).toBe(14);
  });

  it('sets no child params when there are no children', () => {
    const p = buildSearchParams({ country: 'Турция' }, '1', '4');
    expect(p.child).toBe(0);
    expect(p.childage1).toBeUndefined();
  });

  it('carries departure/country and sensible defaults (2 adults, 7–10 nights)', () => {
    const p = buildSearchParams({ country: 'Турция' }, '1', '4');
    expect(p.departure).toBe('1');
    expect(p.country).toBe('4');
    expect(p.adults).toBe(2);
    expect(p.nightsfrom).toBe(7);
    expect(p.nightsto).toBe(10);
  });

  it('passes star and price filters through', () => {
    const p = buildSearchParams({ country: 'Турция', starsFrom: 4, priceTo: 150000 }, '1', '4');
    expect(p.stars).toBe(4);
    expect(p.starsbetter).toBe(1);
    expect(p.priceto).toBe(150000);
  });
});
