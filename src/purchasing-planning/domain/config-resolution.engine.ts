import { DEFAULT_PLANNING_CONFIG } from './constants';
import {
  ConfigContext,
  ConfigScope,
  ConfigValue,
  PlanningConfig,
  PlanningConfigKey,
  ResolvedConfig,
} from './models';

const KEYS = Object.keys(DEFAULT_PLANNING_CONFIG) as PlanningConfigKey[];
const PRECEDENCE: ConfigScope[] = ['SKU', 'SUPPLIER', 'CATEGORY', 'GLOBAL'];

function scopeMatches(value: ConfigValue, context: ConfigContext): boolean {
  if (value.scope === 'GLOBAL') return true;
  const expected =
    value.scope === 'SKU'
      ? context.skuId
      : value.scope === 'SUPPLIER'
        ? context.supplierId
        : context.categoryId;
  return expected != null && String(expected) === String(value.scopeId);
}

export function resolvePlanningConfig(
  values: ConfigValue[],
  context: ConfigContext = {},
): ResolvedConfig {
  const config = { ...DEFAULT_PLANNING_CONFIG } as PlanningConfig;
  const sources = {} as ResolvedConfig['sources'];
  const sourceValues = {} as ResolvedConfig['sourceValues'];
  for (const key of KEYS) {
    const match = PRECEDENCE.map((scope) =>
      values.find(
        (value) =>
          value.active !== false &&
          value.key === key &&
          value.scope === scope &&
          scopeMatches(value, context),
      ),
    ).find((value) => value !== undefined);
    if (match) {
      config[key] = match.value;
      sources[key] = match.scope;
      sourceValues[key] = match;
    } else {
      sources[key] = 'DEFAULT';
      sourceValues[key] = null;
    }
  }
  return { config, sources, sourceValues };
}
