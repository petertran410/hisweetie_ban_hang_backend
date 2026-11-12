import { BadRequestException } from '@nestjs/common';
import {
  isNsxUnit,
  normalizeNsxUnit,
  nsxPriceFactor,
  nsxRawAmount,
} from './nsx-pricing.util';

describe('NSX pricing units', () => {
  it('300 g at 250.000 đ/kg = 75.000 đ', () => {
    expect(
      nsxRawAmount({
        quantity: 300,
        unit: 'g',
        unitPrice: 250000,
        priceUnit: 'kg',
      }).toNumber(),
    ).toBe(75000);
  });

  it('kg priced per gram, same unit and packs', () => {
    expect(
      nsxRawAmount({
        quantity: 1.5,
        unit: 'kg',
        unitPrice: 200,
        priceUnit: 'g',
      }).toNumber(),
    ).toBe(300000);
    expect(
      nsxRawAmount({
        quantity: 40,
        unit: 'gói',
        unitPrice: 12000,
        priceUnit: 'gói',
      }).toNumber(),
    ).toBe(480000);
    expect(nsxPriceFactor('kg', 'kg').toNumber()).toBe(1);
  });

  it('a pack cannot be priced per gram or kg (and vice versa)', () => {
    expect(() => nsxPriceFactor('gói', 'kg')).toThrow(BadRequestException);
    expect(() => nsxPriceFactor('g', 'gói')).toThrow(BadRequestException);
    expect(() => nsxPriceFactor('lb', 'kg')).toThrow(BadRequestException);
  });

  it('accepts NFD / upper-case spellings of gói', () => {
    const nfd = 'Gói'.normalize('NFD');
    expect(normalizeNsxUnit(nfd)).toBe('gói');
    expect(isNsxUnit(` ${nfd} `)).toBe(true);
    expect(nsxPriceFactor(nfd, 'GÓI').toNumber()).toBe(1);
  });

  it('uses decimal arithmetic', () => {
    expect(
      nsxRawAmount({
        quantity: 0.1,
        unit: 'kg',
        unitPrice: 3,
        priceUnit: 'kg',
      }).toNumber(),
    ).toBe(0.3);
    expect(
      nsxRawAmount({
        quantity: 1,
        unit: 'g',
        unitPrice: 0.3,
        priceUnit: 'kg',
      }).toNumber(),
    ).toBe(0.0003);
  });
});
