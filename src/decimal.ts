// A decimal number that keeps the scale it was written with.

import { tagOf } from "./copy.ts";

const NUMBER = /^([+-]?)([0-9]+)(?:\.([0-9]*))?(?:[eE]([+-]?[0-9]+))?$|^([+-]?)\.([0-9]+)(?:[eE]([+-]?[0-9]+))?$/;

const INT32_MIN = -(2 ** 31);
const INT32_MAX = 2 ** 31 - 1;

/**
 * A coefficient and a scale: the number coefficient × 10^-scale.
 *
 * Two decimals are the same value only when both are equal, so 1.5 and 1.50 are different values;
 * {@link Decimal.compare} orders them by the number they denote, in which they are equal. The
 * scale is an int32, as the value model's is.
 */
export class Decimal {
  readonly coefficient: bigint;
  readonly scale: number;

  constructor(coefficient: bigint, scale: number) {
    if (!Number.isInteger(scale) || scale < INT32_MIN || scale > INT32_MAX) {
      throw new RangeError(`a decimal's scale is an int32, not ${scale}`);
    }
    this.coefficient = coefficient;
    this.scale = scale;
  }

  /**
   * The decimal a number written as `[+-]?(digits[.digits]|.digits)([eE][+-]?digits)?` denotes,
   * at the scale it is written with: the digits after the point, less the exponent. `undefined`
   * where the text is not such a number, or its scale is not an int32.
   */
  static parse(text: string): Decimal | undefined {
    const read = NUMBER.exec(text);
    if (read === null) {
      return undefined;
    }
    const [, sign1, whole1, fraction1, exponent1, sign2, fraction2, exponent2] = read;
    const sign = sign1 ?? sign2 ?? "";
    const whole = whole1 ?? "";
    const fraction = fraction1 ?? fraction2 ?? "";
    const exponent = exponent1 ?? exponent2;
    const exponentValue = exponent === undefined ? 0 : Number(exponent);
    const scale = fraction.length - exponentValue;
    if (!Number.isSafeInteger(exponentValue) || scale < INT32_MIN || scale > INT32_MAX) {
      return undefined;
    }
    const magnitude = BigInt(whole + fraction);
    return new Decimal(sign === "-" ? -magnitude : magnitude, scale);
  }

  get [Symbol.toStringTag](): string {
    return tagOf("Decimal");
  }

  /** The decimal of an integer, at scale 0. */
  static of(value: bigint | number): Decimal {
    return new Decimal(BigInt(value), 0);
  }

  /** -1, 0 or 1 as this denotes a number less than, equal to or greater than `other`'s. */
  compare(other: Decimal): number {
    if (this.signum !== other.signum) {
      return this.signum < other.signum ? -1 : 1;
    }
    if (this.signum === 0) {
      return 0;
    }
    // Of two numbers of one sign whose first digits stand at different powers of ten, the one
    // whose first digit stands higher is the larger in magnitude. Settling that first keeps
    // 1E+999999999 and 1E-999999999 from being brought to one scale.
    const above = adjustedExponent(this) - adjustedExponent(other);
    if (above !== 0) {
      return above > 0 === this.signum > 0 ? 1 : -1;
    }
    const [a, b] = aligned(this, other);
    return a < b ? -1 : a > b ? 1 : 0;
  }

  /** Whether the two are the same value: the same coefficient and the same scale. */
  equals(other: Decimal): boolean {
    return this.coefficient === other.coefficient && this.scale === other.scale;
  }

  /** -1, 0 or 1 as the number is negative, zero or positive. */
  get signum(): number {
    return this.coefficient < 0n ? -1 : this.coefficient > 0n ? 1 : 0;
  }

  /** Whether this is an integer multiple of `divisor`, which is not zero. */
  isMultipleOf(divisor: Decimal): boolean {
    if (this.coefficient === 0n) {
      return true;
    }
    // An integer times the divisor has no more digits after the point than the divisor has, once
    // neither carries trailing zeros.
    const value = stripped(this);
    const by = stripped(divisor);
    if (value.scale > by.scale) {
      return false;
    }
    // value / divisor = value's coefficient × 10^n / divisor's, for n the difference of the
    // scales. Past the divisor's own count of 2s and 5s, which its bit length bounds, a further
    // factor of 10 decides nothing, so n is taken no larger than that: 7E-2147483647 does not
    // make a power of ten with two billion digits.
    const divisorDigits = by.coefficient < 0n ? -by.coefficient : by.coefficient;
    const n = Math.min(by.scale - value.scale, divisorDigits.toString(2).length);
    return (value.coefficient * 10n ** BigInt(n)) % by.coefficient === 0n;
  }

  /**
   * The decimal as Java's `BigDecimal.toString` writes it, which is the message form the Raoh
   * Specification gives: plain where the scale is not negative and the first digit's exponent is
   * at least -6, and otherwise one digit before the point and an exponent (`1E+3`, `1.5E-7`).
   */
  toString(): string {
    const digits = (this.coefficient < 0n ? -this.coefficient : this.coefficient).toString();
    const sign = this.coefficient < 0n ? "-" : "";
    const adjusted = digits.length - 1 - this.scale;
    if (this.scale >= 0 && adjusted >= -6) {
      if (this.scale === 0) {
        return sign + digits;
      }
      if (digits.length > this.scale) {
        const point = digits.length - this.scale;
        return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
      }
      return `${sign}0.${"0".repeat(this.scale - digits.length)}${digits}`;
    }
    const mantissa = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
    return `${sign}${mantissa}E${adjusted >= 0 ? "+" : "-"}${Math.abs(adjusted)}`;
  }

  toJSON(): string {
    return this.toString();
  }
}

/** The exponent of the first digit: 2 for 123, -1 for 0.5, 2 for 1.5E+2. */
function adjustedExponent(decimal: Decimal): number {
  const digits = decimal.coefficient < 0n ? -decimal.coefficient : decimal.coefficient;
  return digits.toString().length - 1 - decimal.scale;
}

/** The same number with no trailing zeros in its coefficient. */
function stripped(decimal: Decimal): { coefficient: bigint; scale: number } {
  let { coefficient, scale } = decimal;
  while (coefficient !== 0n && coefficient % 10n === 0n) {
    coefficient /= 10n;
    scale -= 1;
  }
  return { coefficient, scale };
}

/** The two coefficients brought to the larger scale, so that they compare as the numbers do. */
function aligned(
  a: { coefficient: bigint; scale: number },
  b: { coefficient: bigint; scale: number },
): [bigint, bigint] {
  if (a.scale === b.scale) {
    return [a.coefficient, b.coefficient];
  }
  if (a.scale > b.scale) {
    return [a.coefficient, b.coefficient * 10n ** BigInt(a.scale - b.scale)];
  }
  return [a.coefficient * 10n ** BigInt(b.scale - a.scale), b.coefficient];
}
