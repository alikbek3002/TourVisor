import { describe, it, expect } from 'vitest';
import { isoToTv, resolveDateRange } from '../src/services/tourvisor/search.js';

describe('isoToTv', () => {
  it('converts ISO to dd.mm.yyyy', () => {
    expect(isoToTv('2026-07-15')).toBe('15.07.2026');
  });

  it('returns undefined for garbage', () => {
    expect(isoToTv('nonsense')).toBeUndefined();
  });
});

describe('resolveDateRange', () => {
  it('returns empty when no dateFrom is given (Tourvisor defaults apply)', () => {
    expect(resolveDateRange(undefined, undefined)).toEqual({});
  });

  it('defaults dateTo to +7 days when only dateFrom is given', () => {
    expect(resolveDateRange('2026-07-15')).toEqual({ datefrom: '15.07.2026', dateto: '22.07.2026' });
  });

  it('keeps an explicit in-range window', () => {
    expect(resolveDateRange('2026-07-15', '2026-07-20')).toEqual({
      datefrom: '15.07.2026',
      dateto: '20.07.2026',
    });
  });

  it('caps the span at 14 days', () => {
    expect(resolveDateRange('2026-07-01', '2026-08-30')).toEqual({
      datefrom: '01.07.2026',
      dateto: '15.07.2026',
    });
  });

  it('handles month/year rollover in the +7 default', () => {
    expect(resolveDateRange('2026-12-30')).toEqual({ datefrom: '30.12.2026', dateto: '06.01.2027' });
  });
});
