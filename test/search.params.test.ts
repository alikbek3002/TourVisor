import { describe, it, expect } from 'vitest';
import { applyPriceFloor, buildSearchParams, mealCode } from '../src/services/tourvisor/search.js';
import type { TourOption } from '../src/core/types.js';

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

  it('passes a price floor (priceFrom) so pricier options can surface', () => {
    const p = buildSearchParams({ country: 'Турция', priceFrom: 4000, priceTo: 6000 }, '1', '4');
    expect(p.pricefrom).toBe(4000);
    expect(p.priceto).toBe(6000);
  });

  it('joins resolved hotel codes into the `hotels` filter', () => {
    const p = buildSearchParams({ country: 'Турция', hotelName: 'Rixos' }, '1', '4', ['55750', '1451']);
    expect(p.hotels).toBe('55750,1451');
  });

  it('omits the hotels filter when no codes are resolved', () => {
    expect(buildSearchParams({ country: 'Турция' }, '1', '4').hotels).toBeUndefined();
    expect(buildSearchParams({ country: 'Турция' }, '1', '4', []).hotels).toBeUndefined();
  });

  it('forces a 4★ class floor for premium requests when stars not given', () => {
    const p = buildSearchParams({ country: 'Турция', sort: 'premium' }, '1', '4');
    expect(p.stars).toBe(4);
    expect(p.starsbetter).toBe(1);
  });

  it('keeps an explicit star level over the premium default', () => {
    const p = buildSearchParams({ country: 'Турция', sort: 'premium', starsFrom: 5 }, '1', '4');
    expect(p.stars).toBe(5);
  });

  it('does not force a class floor for cheapest/default searches', () => {
    expect(buildSearchParams({ country: 'Турция' }, '1', '4').stars).toBeUndefined();
    expect(buildSearchParams({ country: 'Турция', sort: 'cheapest' }, '1', '4').stars).toBeUndefined();
  });

  it('applies the meal filter when specified', () => {
    const p = buildSearchParams({ country: 'Турция', meal: 'всё включено' }, '1', '4');
    expect(p.meal).toBe(5);
    expect(p.mealbetter).toBe(1);
  });

  it('leaves meal unset when not specified or unknown', () => {
    expect(buildSearchParams({ country: 'Турция' }, '1', '4').meal).toBeUndefined();
    expect(buildSearchParams({ country: 'Турция', meal: 'любое' }, '1', '4').meal).toBeUndefined();
  });
});

describe('applyPriceFloor', () => {
  const opt = (price: number): TourOption => ({ hotelName: 'Отель', price });

  it('drops options priced below the client-named floor', () => {
    const out = applyPriceFloor([opt(3000), opt(5000), opt(7000)], 5000);
    expect(out.map((o) => o.price)).toEqual([5000, 7000]);
  });

  it('returns the list untouched when no floor is given', () => {
    const list = [opt(3000), opt(7000)];
    expect(applyPriceFloor(list)).toBe(list);
  });

  it('can remove everything when nothing clears the floor', () => {
    expect(applyPriceFloor([opt(1000), opt(2000)], 5000)).toEqual([]);
  });
});

describe('mealCode', () => {
  it('maps common meal phrasings to Tourvisor codes', () => {
    expect(mealCode('всё включено')).toBe(5);
    expect(mealCode('все включено')).toBe(5);
    expect(mealCode('all inclusive')).toBe(5);
    expect(mealCode('ультра всё включено')).toBe(7);
    expect(mealCode('полупансион')).toBe(3);
    expect(mealCode('полный пансион')).toBe(4);
    expect(mealCode('только завтрак')).toBe(2);
  });

  it('returns undefined for empty/unknown', () => {
    expect(mealCode(undefined)).toBeUndefined();
    expect(mealCode('любое')).toBeUndefined();
    expect(mealCode('не важно')).toBeUndefined();
  });
});
