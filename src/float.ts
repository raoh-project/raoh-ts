// IEEE 754 binary32 and binary64 values as the Raoh Specification reads and writes them.

import { JsonNumber } from "./input.ts";
import { tagOf } from "./copy.ts";

/** The width of a float: binary32 or binary64. */
export type Width = 32 | 64;

const EXACT_INTEGER = 2n ** 53n;

/** 10^0 to 10^22, each an exact binary64, written as literals rather than computed with `**`. */
const POWERS_OF_TEN = [
  1e0, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11, 1e12, 1e13, 1e14, 1e15, 1e16, 1e17, 1e18, 1e19, 1e20,
  1e21, 1e22,
];

const FORMATS = {
  32: { precision: 24, minExponent: -126, maxExponent: 127 },
  64: { precision: 53, minExponent: -1022, maxExponent: 1023 },
} as const;

/**
 * A float, kept with its width, as an issue's metadata holds one: the width decides how it is
 * written in a message, so that a float32 bound of 0.1 reads `0.1` and not the binary64 digits of
 * the same value.
 */
export class Float {
  readonly value: number;
  readonly width: Width;

  constructor(value: number, width: Width) {
    this.value = width === 32 ? Math.fround(value) : value;
    this.width = width;
  }

  get [Symbol.toStringTag](): string {
    return tagOf("Float");
  }

  valueOf(): number {
    return this.value;
  }

  /** The message form: the canonical decimal, written as Java writes a float. */
  toString(): string {
    return floatMessageForm(this.value, this.width);
  }

  /** The observation of the float: its canonical decimal, or a tag where JSON cannot carry it. */
  toJSON(): JsonNumber | { float: string } {
    return floatJson(this.value, this.width);
  }
}

/**
 * A float as the Raoh Specification observes it: its canonical decimal as a JSON number, or a
 * tag, `{"float": "-0"}`, `{"float": "NaN"}`, `{"float": "+Infinity"}` or
 * `{"float": "-Infinity"}`, where JSON cannot carry it.
 */
export function floatJson(value: number, width: Width): JsonNumber | { float: string } {
  if (Number.isNaN(value)) return { float: "NaN" };
  if (value === Infinity) return { float: "+Infinity" };
  if (value === -Infinity) return { float: "-Infinity" };
  if (Object.is(value, -0)) return { float: "-0" };
  return new JsonNumber(value === 0 ? "0" : floatMessageForm(value, width));
}

/**
 * The float of the given width nearest to ±coefficient × 10^exponent, rounding to nearest with
 * ties to even, once: `Infinity` (with the sign) where it rounds beyond the largest finite value.
 * The number is read exactly, so a float32 is not rounded through a binary64 first.
 */
export function nearestFloat(negative: boolean, coefficient: bigint, exponent: number, width: Width): number {
  const sign = negative ? -1 : 1;
  if (coefficient === 0n) {
    return negative ? -0 : 0;
  }
  // Clinger's fast path: an integer below 2^53 and a power of ten up to 10^22 are both exact
  // binary64 values, so one multiplication or division rounds the number once.
  if (width === 64 && coefficient < EXACT_INTEGER && exponent >= -22 && exponent <= 22) {
    const digits = Number(coefficient);
    const power = POWERS_OF_TEN[Math.abs(exponent)] as number;
    return sign * (exponent >= 0 ? digits * power : digits / power);
  }
  // Far enough beyond either end of binary64 that the answer is known without the arithmetic.
  const magnitude = coefficient.toString().length - 1 + exponent;
  if (magnitude > 400) {
    return sign * Infinity;
  }
  if (magnitude < -400) {
    return negative ? -0 : 0;
  }
  let numerator = coefficient;
  let denominator = 1n;
  if (exponent >= 0) {
    numerator *= 10n ** BigInt(exponent);
  } else {
    denominator = 10n ** BigInt(-exponent);
  }
  const { precision, minExponent, maxExponent } = FORMATS[width];
  // The binary exponent of the leading bit: 2^e <= numerator / denominator < 2^(e+1).
  let e = bitLength(numerator) - bitLength(denominator);
  if (compareWithPowerOfTwo(numerator, denominator, e) < 0) {
    e -= 1;
  }
  let shift = Math.max(e, minExponent) - (precision - 1);
  let n = numerator;
  let d = denominator;
  if (shift >= 0) {
    d <<= BigInt(shift);
  } else {
    n <<= BigInt(-shift);
  }
  let mantissa = n / d;
  const twice = 2n * (n - mantissa * d);
  if (twice > d || (twice === d && (mantissa & 1n) === 1n)) {
    mantissa += 1n;
  }
  if (mantissa === 1n << BigInt(precision)) {
    mantissa >>= 1n;
    shift += 1;
  }
  if (bitLength(mantissa) - 1 + shift > maxExponent) {
    return sign * Infinity;
  }
  return sign * Number(mantissa) * 2 ** shift;
}

/**
 * The canonical decimal of a finite, non-zero float as `digits × 10^exponent`, with no trailing
 * zero in `digits`: the decimal of the least length that rounds to the float, the one closest to
 * it, ties going to the even coefficient; where one digit is enough, the closest decimal of one or
 * two digits, so that the least float64 is `4.9E-324` rather than `5E-324`.
 */
export function canonicalDecimal(value: number, width: Width): { digits: string; exponent: number } {
  const magnitude = Math.abs(value);
  const [numerator, denominator] = exactly(magnitude);
  let leading = Math.floor(Math.log10(magnitude));
  // log10 is near enough to be off by one at most; settle it exactly.
  while (compareWithPowerOfTen(numerator, denominator, leading) < 0) {
    leading -= 1;
  }
  while (compareWithPowerOfTen(numerator, denominator, leading + 1) >= 0) {
    leading += 1;
  }
  for (let length = 1; length <= 17; length += 1) {
    const grid = leading - length + 1;
    const coefficient = nearestOnGrid(numerator, denominator, grid);
    if (nearestFloat(false, coefficient, grid, width) !== magnitude) {
      continue;
    }
    if (length > 1) {
      return stripped(coefficient, grid);
    }
    // One digit reaches the float, so two may come closer, and the closest of those is
    // as close as any decimal of one or two digits.
    return stripped(nearestOnGrid(numerator, denominator, grid - 1), grid - 1);
  }
  throw new Error(`no decimal of up to 17 digits rounds to ${value}`);
}

/**
 * The message form of a float: its canonical decimal, plain with at least one digit after the
 * point where the first digit's exponent is from -3 to 6, and otherwise one digit, a point, the
 * others (at least one), `E` and the exponent; `0.0`, `-0.0`, `NaN`, `Infinity`, `-Infinity`.
 */
export function floatMessageForm(value: number, width: Width): string {
  if (Number.isNaN(value)) {
    return "NaN";
  }
  if (value === Infinity) {
    return "Infinity";
  }
  if (value === -Infinity) {
    return "-Infinity";
  }
  if (value === 0) {
    return Object.is(value, -0) ? "-0.0" : "0.0";
  }
  const sign = value < 0 ? "-" : "";
  const { digits, exponent } = canonicalDecimal(value, width);
  const first = exponent + digits.length - 1;
  if (first < -3 || first > 6) {
    return `${sign}${digits[0]}.${digits.slice(1) || "0"}E${first}`;
  }
  if (exponent >= 0) {
    return `${sign}${digits}${"0".repeat(exponent)}.0`;
  }
  const point = digits.length + exponent;
  if (point > 0) {
    return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
  }
  return `${sign}0.${"0".repeat(-point)}${digits}`;
}

/**
 * -1, 0 or 1 as `a` comes before, with or after `b` in the float order of the value model: -∞,
 * the negative values, -0, +0, the positive values, +∞, and last NaN.
 */
export function compareFloats(a: number, b: number): number {
  const aNaN = Number.isNaN(a);
  const bNaN = Number.isNaN(b);
  if (aNaN || bNaN) {
    return aNaN === bNaN ? 0 : aNaN ? 1 : -1;
  }
  if (a !== b) {
    return a < b ? -1 : 1;
  }
  if (a === 0) {
    const aNegative = Object.is(a, -0);
    return aNegative === Object.is(b, -0) ? 0 : aNegative ? -1 : 1;
  }
  return 0;
}

/** Whether the two are the same float: +0 and -0 differ, and NaN is NaN. */
export function sameFloat(a: number, b: number): boolean {
  return Object.is(a, b);
}

function bitLength(n: bigint): number {
  return n === 0n ? 0 : n.toString(2).length;
}

/** The sign of numerator / denominator - 2^e. */
function compareWithPowerOfTwo(numerator: bigint, denominator: bigint, e: number): number {
  const left = e >= 0 ? numerator : numerator << BigInt(-e);
  const right = e >= 0 ? denominator << BigInt(e) : denominator;
  return left < right ? -1 : left > right ? 1 : 0;
}

/** The sign of numerator / denominator - 10^e. */
function compareWithPowerOfTen(numerator: bigint, denominator: bigint, e: number): number {
  const left = e >= 0 ? numerator : numerator * 10n ** BigInt(-e);
  const right = e >= 0 ? denominator * 10n ** BigInt(e) : denominator;
  return left < right ? -1 : left > right ? 1 : 0;
}

/** A finite, positive binary64 as an exact fraction. */
function exactly(magnitude: number): [bigint, bigint] {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, magnitude);
  const bits = view.getBigUint64(0);
  const biased = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & ((1n << 52n) - 1n);
  const mantissa = biased === 0 ? fraction : fraction | (1n << 52n);
  const exponent = (biased === 0 ? 1 : biased) - 1075;
  return exponent >= 0 ? [mantissa << BigInt(exponent), 1n] : [mantissa, 1n << BigInt(-exponent)];
}

/** The integer nearest numerator / (denominator × 10^grid), ties to even. */
function nearestOnGrid(numerator: bigint, denominator: bigint, grid: number): bigint {
  let n = numerator;
  let d = denominator;
  if (grid >= 0) {
    d *= 10n ** BigInt(grid);
  } else {
    n *= 10n ** BigInt(-grid);
  }
  let q = n / d;
  const twice = 2n * (n - q * d);
  if (twice > d || (twice === d && (q & 1n) === 1n)) {
    q += 1n;
  }
  return q;
}

function stripped(coefficient: bigint, exponent: number): { digits: string; exponent: number } {
  let digits = coefficient.toString();
  while (digits.length > 1 && digits.endsWith("0")) {
    digits = digits.slice(0, -1);
    exponent += 1;
  }
  return { digits, exponent };
}
