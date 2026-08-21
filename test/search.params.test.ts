import { describe, it, expect } from 'vitest';
import {
  applyPriceFloor,
  buildSearchParams,
  mealCode,
  pickTour,
  rankOptions,
} from '../src/services/tourvisor/search.js';
import type { TourOption } from '../src/core/types.js';
import type { TvHotel } from '../src/services/tourvisor/types.js';

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

  it('passes star and price filters through (deriving a budget floor)', () => {
    const p = buildSearchParams({ country: 'Турция', starsFrom: 4, priceTo: 150000 }, '1', '4');
    expect(p.stars).toBe(4);
    expect(p.starsbetter).toBe(1);
    expect(p.priceto).toBe(150000);
    expect(p.pricefrom).toBe(90000); // named budget → aim near it (60%)
  });

  it('passes a client range exactly — no derivation of the floor', () => {
    const p = buildSearchParams({ country: 'Турция', priceFrom: 4000, priceTo: 6000 }, '1', '4');
    expect(p.pricefrom).toBe(4000);
    expect(p.priceto).toBe(6000);
    expect(p.stars).toBe(4); // named budget still means decent hotels
  });

  it('a bare budget ceiling derives a 60% floor and a 4★ class floor', () => {
    const p = buildSearchParams({ country: 'Турция', priceTo: 5000 }, '1', '4');
    expect(p.pricefrom).toBe(3000);
    expect(p.priceto).toBe(5000);
    expect(p.stars).toBe(4);
    expect(p.starsbetter).toBe(1);
  });

  it('explicit "cheapest" keeps the old semantics: no derived floor, no class floor', () => {
    const p = buildSearchParams({ country: 'Турция', priceTo: 5000, sort: 'cheapest' }, '1', '4');
    expect(p.pricefrom).toBeUndefined();
    expect(p.priceto).toBe(5000);
    expect(p.stars).toBeUndefined();
  });

  it('relaxed mode drops derived constraints but keeps explicit client values', () => {
    const derived = buildSearchParams({ country: 'Турция', priceTo: 5000 }, '1', '4', undefined, {
      relaxed: true,
    });
    expect(derived.pricefrom).toBeUndefined();
    expect(derived.stars).toBeUndefined();
    expect(derived.priceto).toBe(5000);

    const explicit = buildSearchParams(
      { country: 'Турция', priceFrom: 4000, priceTo: 6000, starsFrom: 5 },
      '1',
      '4',
      undefined,
      { relaxed: true },
    );
    expect(explicit.pricefrom).toBe(4000);
    expect(explicit.stars).toBe(5);
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

  it('premium raises a too-low explicit star level to 4★', () => {
    const p = buildSearchParams({ country: 'Турция', sort: 'premium', starsFrom: 3 }, '1', '4');
    expect(p.stars).toBe(4); // otherwise the premium re-search is byte-identical
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

describe('rankOptions', () => {
  const opt = (price: number, stars?: number, rating?: number): TourOption => ({
    hotelName: `H${price}`,
    price,
    stars,
    rating,
  });

  it('keeps price-ascending order for explicit cheapest and for no-budget searches', () => {
    const list = [opt(1000), opt(2000), opt(3000)];
    expect(rankOptions(list, { sort: 'cheapest', priceTo: 5000 })).toBe(list);
    expect(rankOptions(list, {})).toBe(list);
  });

  it('named budget → closest to the ceiling first', () => {
    const ranked = rankOptions([opt(3100), opt(4900, 4), opt(4200, 5)], { priceTo: 5000 });
    expect(ranked.map((o) => o.price)).toEqual([4900, 4200, 3100]);
  });

  it('named budget → quality breaks price ties', () => {
    const ranked = rankOptions([opt(4900, 3), opt(4900, 5)], { priceTo: 5000 });
    expect(ranked[0]?.stars).toBe(5);
  });

  it('premium → best hotels first; unrated 5★ beats rated 3★', () => {
    const rated3 = opt(2000, 3, 3.8);
    const unrated5 = opt(1500, 5); // no rating → falls back to stars*0.9 = 4.5
    const rated49 = opt(3000, 5, 4.9);
    const ranked = rankOptions([rated3, unrated5, rated49], { sort: 'premium' });
    expect(ranked.map((o) => o.hotelName)).toEqual([rated49.hotelName, unrated5.hotelName, rated3.hotelName]);
  });
});

describe('pickTour', () => {
  const hotel = (...prices: number[]): TvHotel => ({
    tours: { tour: prices.map((p) => ({ price: p })) },
  });

  it('defaults to the cheapest tour (no budget context)', () => {
    expect(pickTour(hotel(2900, 4800, 3500))?.price).toBe(2900);
    expect(pickTour(hotel(2900, 4800), { cheap: true, priceTo: 5000 })?.price).toBe(2900);
  });

  it('with a named budget picks the most expensive tour that fits', () => {
    expect(pickTour(hotel(2900, 4800, 5600), { priceTo: 5000 })?.price).toBe(4800);
  });

  it('with a client range picks the priciest tour inside the range', () => {
    expect(pickTour(hotel(2900, 4500, 5900), { priceFrom: 4000, priceTo: 5000 })?.price).toBe(4500);
  });

  it('with only an explicit floor picks the cheapest qualifying tour', () => {
    // The hotel must not be dropped by applyPriceFloor when a pricier tour exists.
    expect(pickTour(hotel(2900, 5200, 6100), { priceFrom: 5000 })?.price).toBe(5200);
  });

  it('falls back to the cheapest when nothing fits the budget', () => {
    expect(pickTour(hotel(5600, 7000), { priceTo: 5000 })?.price).toBe(5600);
  });

  it('returns undefined for a hotel without tours', () => {
    expect(pickTour({ tours: { tour: [] } })).toBeUndefined();
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
