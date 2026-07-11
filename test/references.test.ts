import { describe, it, expect } from 'vitest';
import { normalize } from '../src/services/tourvisor/references.js';

describe('normalize', () => {
  it('lowercases and strips punctuation/spaces', () => {
    expect(normalize('  Санкт-Петербург ')).toBe('санктпетербург');
  });

  it('treats ё as е', () => {
    expect(normalize('Орёл')).toBe('орел');
  });

  it('keeps digits and latin letters', () => {
    expect(normalize('ОАЭ 2')).toBe('оаэ2');
  });
});
