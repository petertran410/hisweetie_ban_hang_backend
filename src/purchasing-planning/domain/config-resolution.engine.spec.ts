import { DEFAULT_PLANNING_CONFIG } from './constants';
import { resolvePlanningConfig } from './config-resolution.engine';

describe('resolvePlanningConfig', () => {
  it('uses PRD defaults when no overrides exist', () => {
    const result = resolvePlanningConfig([]);
    expect(result.config).toEqual(DEFAULT_PLANNING_CONFIG);
    expect(result.sources.safetyDays).toBe('DEFAULT');
    expect(Object.keys(result.config)).toEqual([
      'safetyDays',
      'coverageDays',
    ]);
  });

  it('resolves every field with SKU > supplier > category > global precedence', () => {
    const result = resolvePlanningConfig(
      [
        { scope: 'GLOBAL', key: 'safetyDays', value: 30 },
        { scope: 'CATEGORY', scopeId: 7, key: 'safetyDays', value: 25 },
        { scope: 'SUPPLIER', scopeId: 8, key: 'safetyDays', value: 20 },
        { scope: 'SKU', scopeId: 9, key: 'safetyDays', value: 15 },
        { scope: 'SUPPLIER', scopeId: 8, key: 'coverageDays', value: 45 },
      ],
      { skuId: 9, supplierId: 8, categoryId: 7 },
    );
    expect(result.config.safetyDays).toBe(15);
    expect(result.sources.safetyDays).toBe('SKU');
    expect(result.config.coverageDays).toBe(45);
    expect(result.sources.coverageDays).toBe('SUPPLIER');
    expect(result.sourceValues.coverageDays?.scopeId).toBe(8);
  });

  it('ignores inactive values so deleting a field resets it to inheritance', () => {
    const result = resolvePlanningConfig(
      [
        { scope: 'GLOBAL', key: 'safetyDays', value: 14 },
        {
          scope: 'SKU',
          scopeId: 9,
          key: 'safetyDays',
          value: 2,
          active: false,
        },
      ],
      { skuId: 9 },
    );
    expect(result.config.safetyDays).toBe(14);
    expect(result.sources.safetyDays).toBe('GLOBAL');
  });
});
