export interface Decimal { coefficient: bigint; scale: number }
export function decimal(value: string): Decimal {
  const match = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(value);
  if (!match || value.length > 1024) throw new Error('invalid_decimal');
  const fraction = match[2] ?? '';
  const exponent = Number(match[3] ?? 0);
  if (!Number.isInteger(exponent) || Math.abs(exponent) > 308) throw new Error('invalid_decimal');
  const scale = fraction.length - exponent;
  const coefficient = BigInt(match[1]! + fraction);
  return scale < 0 ? { coefficient: coefficient * 10n ** BigInt(-scale), scale: 0 } : { coefficient, scale };
}
export function add(a: Decimal, b: Decimal): Decimal {
  const scale = Math.max(a.scale, b.scale);
  return { coefficient: a.coefficient * 10n ** BigInt(scale - a.scale) + b.coefficient * 10n ** BigInt(scale - b.scale), scale };
}
export function valueOf(raw: string, decimals: number, price: string): Decimal {
  const parsed = decimal(price);
  return { coefficient: BigInt(raw) * parsed.coefficient, scale: decimals + parsed.scale };
}
export function displayRaw(raw: string, decimals: number): string {
  if (decimals === 0) return BigInt(raw).toString();
  const text = BigInt(raw).toString().padStart(decimals + 1, '0');
  return `${text.slice(0, -decimals)}.${text.slice(-decimals)}`;
}
/** Nonnegative round-half-up; divisor is applied before rounding (daily average is exactly /7). */
export function rounded(value: Decimal, places = 6, divisor = 1n): string {
  const numerator = value.coefficient * 10n ** BigInt(places);
  const denominator = 10n ** BigInt(value.scale) * divisor;
  return displayRaw(((numerator * 2n + denominator) / (2n * denominator)).toString(), places);
}
