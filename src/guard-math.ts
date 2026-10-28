/** Reduced exact fractions used by the published composition guard. */
export interface Fraction { num: bigint; den: bigint }
export function fraction(num: bigint, den = 1n): Fraction {
  if (den === 0n) throw new RangeError('zero denominator');
  if (den < 0n) { num = -num; den = -den; }
  let a = num < 0n ? -num : num, b = den;
  while (b) { const r = a % b; a = b; b = r; }
  return { num: num / a, den: den / a };
}
export const addFraction = (a: Fraction, b: Fraction): Fraction => fraction(a.num * b.den + b.num * a.den, a.den * b.den);
export const multiplyFraction = (a: Fraction, b: Fraction): Fraction => fraction(a.num * b.num, a.den * b.den);
export const compareFraction = (a: Fraction, b: Fraction): number => a.num * b.den < b.num * a.den ? -1 : a.num * b.den > b.num * a.den ? 1 : 0;
export const fractionNumber = (a: Fraction): number => Number(a.num) / Number(a.den);
export function choose(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= k; i++) r = r * (n - k + i) / i;
  return Math.round(r);
}
export function falling(n: number, k: number): number {
  let r = 1;
  for (let i = 0; i < k; i++) r *= n - i;
  return r;
}
