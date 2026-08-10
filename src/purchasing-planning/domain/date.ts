const DAY_MS = 86_400_000;

export function toDateKey(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime()))
    throw new Error(`Invalid date: ${value}`);
  return date.toISOString().slice(0, 10);
}

export function addDays(value: string | Date, days: number): string {
  const date = new Date(`${toDateKey(value)}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return toDateKey(date);
}

export function daysBetween(from: string | Date, to: string | Date): number {
  const start = new Date(`${toDateKey(from)}T00:00:00.000Z`).getTime();
  const end = new Date(`${toDateKey(to)}T00:00:00.000Z`).getTime();
  return Math.floor((end - start) / DAY_MS);
}

export function round(value: number, digits = 4): number {
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}
