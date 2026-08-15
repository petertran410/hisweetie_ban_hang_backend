export function toVnd(
  price: unknown,
  currency: string | null | undefined,
  exchangeRate: unknown,
): number | null {
  if (price == null) return null;

  const value = Number(price);
  if (!Number.isFinite(value)) return null;
  if ((currency || 'VND').toUpperCase() === 'VND') return value;

  if (exchangeRate == null) return null;
  const rate = Number(exchangeRate);
  return Number.isFinite(rate) ? value * rate : null;
}
