import { describe, it, expect } from 'vitest';
import { mapResults, normalizeCurrency } from '../src/services/tourvisor/search.js';
import type { TvResultResponse } from '../src/services/tourvisor/types.js';

describe('normalizeCurrency', () => {
  it('maps known codes to symbols', () => {
    expect(normalizeCurrency('RUB')).toBe('₽');
    expect(normalizeCurrency('usd')).toBe('$');
    expect(normalizeCurrency('EUR')).toBe('€');
  });

  it('passes through unknown codes', () => {
    expect(normalizeCurrency('XYZ')).toBe('XYZ');
  });

  it('returns undefined for empty input', () => {
    expect(normalizeCurrency(undefined)).toBeUndefined();
  });
});

describe('mapResults', () => {
  it('returns [] when there are no hotels', () => {
    expect(mapResults({})).toEqual([]);
    expect(mapResults({ data: { result: {} } } as TvResultResponse)).toEqual([]);
  });

  it('maps a single hotel (object, not array) with string numbers, picking the cheapest tour', () => {
    const res = {
      data: {
        result: {
          hotel: {
            hotelname: 'Rixos',
            hotelstars: '5',
            regionname: 'Анталия',
            countryname: 'Турция',
            fulldesclink: 'https://t/hotel/1',
            tours: {
              tour: [
                { price: '90000', nights: '7', currency: 'RUB', mealrussian: 'Всё включено', operatorname: 'Pegas', flydate: '15.07.2026' },
                { price: '80000', nights: '7', currency: 'RUB', mealrussian: 'Всё включено', operatorname: 'Anex', flydate: '16.07.2026' },
              ],
            },
          },
        },
      },
    } as unknown as TvResultResponse;

    const options = mapResults(res);
    expect(options).toHaveLength(1);
    expect(options[0]).toMatchObject({
      hotelName: 'Rixos',
      stars: 5,
      region: 'Анталия',
      country: 'Турция',
      meal: 'Всё включено',
      nights: 7,
      price: 80000, // cheapest of the two tours
      currency: '₽',
      operator: 'Anex',
      link: 'https://t/hotel/1',
    });
  });

  it('sorts hotels by price ascending and skips hotels without tours', () => {
    const res = {
      data: {
        result: {
          hotel: [
            { hotelname: 'Expensive', tours: { tour: { price: '200000' } } },
            { hotelname: 'Cheap', tours: { tour: { price: '50000' } } },
            { hotelname: 'NoTours' },
          ],
        },
      },
    } as unknown as TvResultResponse;

    const options = mapResults(res);
    expect(options.map((o) => o.hotelName)).toEqual(['Cheap', 'Expensive']);
  });

  it('falls back to hotel.price when the tour has no price', () => {
    const res = {
      data: { result: { hotel: { hotelname: 'H', price: '12345', tours: { tour: { nights: '7' } } } } },
    } as unknown as TvResultResponse;

    expect(mapResults(res)[0]?.price).toBe(12345);
  });
});
