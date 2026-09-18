import {
  GrowthFactorConfidence,
  LegacyForecastResult,
} from './stability.engine';

export type ForecastFormulaMode = 'LEGACY' | 'NEW' | 'SHADOW';
export type EffectiveForecastFormulaMode = 'LEGACY' | 'NEW';

export interface ForecastFormulaModeResolution {
  configuredMode: ForecastFormulaMode;
  effectiveMode: EffectiveForecastFormulaMode;
  fallbackApplied: boolean;
  warnings: string[];
}

export interface ForecastFormulaSelection {
  configuredMode: ForecastFormulaMode;
  effectiveMode: EffectiveForecastFormulaMode;
  baselineDailyDemand: number;
  systemGrowthFactor: number;
  fallbackApplied: boolean;
  warnings: string[];
  legacyShadow: LegacyForecastResult | null;
}

export function resolveForecastFormulaMode(
  rawMode?: string | null,
): ForecastFormulaModeResolution {
  const normalized = String(rawMode ?? 'NEW')
    .trim()
    .toUpperCase();
  if (
    normalized === 'LEGACY' ||
    normalized === 'NEW' ||
    normalized === 'SHADOW'
  ) {
    return {
      configuredMode: normalized,
      effectiveMode: normalized === 'SHADOW' ? 'NEW' : normalized,
      fallbackApplied: false,
      warnings: [],
    };
  }
  return {
    configuredMode: 'NEW',
    effectiveMode: 'NEW',
    fallbackApplied: true,
    warnings: ['FORMULA_MODE_FALLBACK'],
  };
}

export function selectForecastFormula(input: {
  mode: ForecastFormulaModeResolution;
  stabilityBaselineDailyDemand: number;
  stabilityGrowthFactor: number;
  stabilityConfidence: GrowthFactorConfidence;
  legacy: LegacyForecastResult;
  fallbackDailyDemand: number;
}): ForecastFormulaSelection {
  const warnings = [...input.mode.warnings];
  let fallbackApplied = input.mode.fallbackApplied;
  let baselineDailyDemand =
    input.stabilityBaselineDailyDemand > 0
      ? input.stabilityBaselineDailyDemand
      : input.fallbackDailyDemand;
  let systemGrowthFactor = input.stabilityGrowthFactor;

  if (
    !Number.isFinite(systemGrowthFactor) ||
    systemGrowthFactor <= 0 ||
    input.stabilityConfidence === 'NO_DATA'
  ) {
    systemGrowthFactor = 1;
    fallbackApplied = true;
    warnings.push('GROWTH_FACTOR_FALLBACK');
  }

  if (input.mode.effectiveMode === 'LEGACY') {
    baselineDailyDemand =
      input.legacy.baselineDailyDemand > 0
        ? input.legacy.baselineDailyDemand
        : input.fallbackDailyDemand;
    systemGrowthFactor =
      Number.isFinite(input.legacy.growthFactor) &&
      input.legacy.growthFactor > 0
        ? input.legacy.growthFactor
        : 1;
    if (input.legacy.monthsUsed < 2) {
      systemGrowthFactor = 1;
      fallbackApplied = true;
      warnings.push('GROWTH_FACTOR_FALLBACK');
    }
  }

  return {
    configuredMode: input.mode.configuredMode,
    effectiveMode: input.mode.effectiveMode,
    baselineDailyDemand,
    systemGrowthFactor,
    fallbackApplied,
    warnings: [...new Set(warnings)],
    legacyShadow: input.mode.configuredMode === 'SHADOW' ? input.legacy : null,
  };
}
