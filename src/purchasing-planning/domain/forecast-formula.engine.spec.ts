import {
  resolveForecastFormulaMode,
  selectForecastFormula,
} from './forecast-formula.engine';

const legacy = {
  baselineDailyDemand: 8,
  growthFactor: 1.1,
  monthsUsed: 5,
  excludedMonths: [],
};

describe('forecast formula mode', () => {
  it('uses NEW by default and for SHADOW', () => {
    expect(resolveForecastFormulaMode(undefined)).toMatchObject({
      configuredMode: 'NEW',
      effectiveMode: 'NEW',
      fallbackApplied: false,
    });
    expect(resolveForecastFormulaMode('shadow')).toMatchObject({
      configuredMode: 'SHADOW',
      effectiveMode: 'NEW',
      fallbackApplied: false,
    });
  });

  it('falls back to NEW when the configured mode is invalid', () => {
    expect(resolveForecastFormulaMode('unknown')).toEqual({
      configuredMode: 'NEW',
      effectiveMode: 'NEW',
      fallbackApplied: true,
      warnings: ['FORMULA_MODE_FALLBACK'],
    });
  });

  it('selects the legacy baseline and factor for LEGACY', () => {
    const result = selectForecastFormula({
      mode: resolveForecastFormulaMode('LEGACY'),
      stabilityBaselineDailyDemand: 10,
      stabilityGrowthFactor: 1.2,
      stabilityConfidence: 'HIGH',
      legacy,
      fallbackDailyDemand: 9,
    });

    expect(result).toMatchObject({
      effectiveMode: 'LEGACY',
      baselineDailyDemand: 8,
      systemGrowthFactor: 1.1,
    });
    expect(result.legacyShadow).toBeNull();
  });

  it('keeps the new forecast in SHADOW and returns the legacy comparison', () => {
    const result = selectForecastFormula({
      mode: resolveForecastFormulaMode('SHADOW'),
      stabilityBaselineDailyDemand: 10,
      stabilityGrowthFactor: 1.2,
      stabilityConfidence: 'HIGH',
      legacy,
      fallbackDailyDemand: 9,
    });

    expect(result).toMatchObject({
      configuredMode: 'SHADOW',
      effectiveMode: 'NEW',
      baselineDailyDemand: 10,
      systemGrowthFactor: 1.2,
    });
    expect(result.legacyShadow).toEqual(legacy);
  });

  it('falls back to factor 1.00 when stability has NO_DATA', () => {
    const result = selectForecastFormula({
      mode: resolveForecastFormulaMode('NEW'),
      stabilityBaselineDailyDemand: 0,
      stabilityGrowthFactor: 0,
      stabilityConfidence: 'NO_DATA',
      legacy,
      fallbackDailyDemand: 4,
    });

    expect(result).toMatchObject({
      baselineDailyDemand: 4,
      systemGrowthFactor: 1,
      fallbackApplied: true,
    });
    expect(result.warnings).toContain('GROWTH_FACTOR_FALLBACK');
  });
});
