import { describe, it, expect } from 'vitest';
import { matchHotels } from '../src/services/tourvisor/references.js';
import type { TvRefHotel } from '../src/services/tourvisor/types.js';

// Shape mirrors the live list.php?type=hotel response (names are UPPERCASE latin).
const HOTELS: TvRefHotel[] = [
  { id: '126576', name: '07 GROUP HOTEL', stars: '3', region: '19' },
  { id: '55750', name: 'CLUB PRIVE BY RIXOS BELEK', stars: '5', region: '21' },
  { id: '1451', name: 'DELPHIN BE GRAND (EX. BOTANIK, RIXOS LARES)', stars: '5', region: '20' },
  { id: '900', name: 'RIXOS PREMIUM BELEK', stars: '5', region: '21' },
  { id: '901', name: 'RIXOS DOWNTOWN ANTALYA', stars: '5', region: '20' },
  { id: '500', name: 'DELPHIN IMPERIAL', stars: '5', region: '20' },
];

describe('matchHotels', () => {
  it('finds an exact hotel by name regardless of case/spacing', () => {
    const m = matchHotels(HOTELS, 'rixos premium belek');
    expect(m[0]?.id).toBe('900');
    expect(m[0]?.name).toBe('RIXOS PREMIUM BELEK');
    expect(m[0]?.stars).toBe(5);
  });

  it('when an exact match exists, does not dilute with other substring hits', () => {
    const m = matchHotels(HOTELS, 'Delphin Imperial');
    expect(m).toHaveLength(1);
    expect(m[0]?.id).toBe('500');
  });

  it('a bare brand word returns several matches, shortest (closest) first', () => {
    const ids = matchHotels(HOTELS, 'rixos').map((h) => h.id);
    expect(ids).toContain('900'); // RIXOS PREMIUM BELEK
    expect(ids).toContain('901'); // RIXOS DOWNTOWN ANTALYA
    expect(ids).toContain('55750'); // CLUB PRIVE BY RIXOS BELEK
    // A prefix match ("RIXOS …") should outrank a mid-string one ("… RIXOS …").
    expect(ids.indexOf('900')).toBeLessThan(ids.indexOf('55750'));
  });

  it('respects the result limit', () => {
    expect(matchHotels(HOTELS, 'rixos', 2)).toHaveLength(2);
  });

  it('returns nothing for too-short or unknown queries', () => {
    expect(matchHotels(HOTELS, 'ri')).toEqual([]);
    expect(matchHotels(HOTELS, 'hilton maldives')).toEqual([]);
  });
});
