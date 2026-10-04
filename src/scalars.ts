// The decoders of scalars, and the operations each kind of scalar has.

import { Decimal } from "./decimal.ts";
import { Chain, type Run } from "./decoder.ts";
import { Float, type Width, nearestFloat } from "./float.ts";
import { kindOf, lexemeOf } from "./input.ts";
import { Issue, type Result, failed, ok } from "./issue.ts";
import { compareValues, includesSame } from "./meta.ts";
import { isCuid, isEmail, isIpv4, isIpv6, isUlid, isUuid, uriParts } from "./text.ts";

const REQUIRED = new Issue("required");

function typeMismatch(expected: string, input: unknown): Issue {
  return new Issue("type_mismatch", { meta: { expected, actual: kindOf(input) } });
}

function numericRange(expected: string): Issue {
  return new Issue("type_mismatch", { messageKey: "type_mismatch.numeric_range", meta: { expected } });
}

/**
 * A scalar decoder's first step: absent or null gives `required`, a value of another kind
 * `type_mismatch`, and a value of the kind what `read` makes of it.
 */
function scalar<T>(expected: string, kind: string, read: (input: unknown) => Result<T>): Run<T> {
  return (input, path) => {
    if (input === undefined || input === null) {
      return failed(REQUIRED.under(path));
    }
    if (kindOf(input) !== kind) {
      return failed(typeMismatch(expected, input).under(path));
    }
    const made = read(input);
    return made.issues === undefined ? made : failed(made.issues.under(path));
  };
}

const INTEGER = /^-?(?:0|[1-9][0-9]*)$/;
const INT32_MIN = -(2n ** 31n);
const INT32_MAX = 2n ** 31n - 1n;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

/** An integer of the input model within [min, max], or the issue that says why it is not one. */
function integer(input: unknown, expected: string, min: bigint, max: bigint): Result<bigint> {
  const lexeme = lexemeOf(input);
  if (lexeme === undefined || !INTEGER.test(lexeme)) {
    return failed(typeMismatch(expected, input));
  }
  const value = BigInt(lexeme);
  return value < min || value > max ? failed(numericRange(expected)) : ok(value);
}

/** The parts of a JSON number's lexeme: its sign, its digits as one integer, and the power of ten they are scaled by. */
function numberParts(lexeme: string): { negative: boolean; coefficient: bigint; exponent: number } | undefined {
  const decimal = Decimal.parse(lexeme);
  if (decimal === undefined) {
    return undefined;
  }
  const negative = lexeme.startsWith("-");
  return { negative, coefficient: negative ? -decimal.coefficient : decimal.coefficient, exponent: -decimal.scale };
}

function floatOf(input: unknown, expected: string, width: Width): Result<number> {
  // A JavaScript number is already a float64, so it is the value, or rounded once to a float32.
  if (typeof input === "number") {
    if (!Number.isFinite(input)) {
      return failed(typeMismatch(expected, input));
    }
    const value = width === 32 ? Math.fround(input) : input;
    return Number.isFinite(value) ? ok(value) : failed(numericRange(expected));
  }
  const lexeme = lexemeOf(input);
  const parts = lexeme === undefined ? undefined : numberParts(lexeme);
  if (parts === undefined) {
    return failed(typeMismatch(expected, input));
  }
  const value = nearestFloat(parts.negative, parts.coefficient, parts.exponent, width);
  return Number.isFinite(value) ? ok(value) : failed(numericRange(expected));
}

/** The number of Unicode code points in `text`. */
function codePoints(text: string): number {
  let count = 0;
  for (const _ of text) {
    count += 1;
  }
  return count;
}

/** A decoder of strings, with the operations on strings. */
export class StringDecoder extends Chain<string> {
  /** Gives `too_short` where the string has fewer code points than `min`. */
  minLength(min: number, message?: string): this {
    return this.check((s) => {
      const actual = codePoints(s);
      return actual < min ? new Issue("too_short", { meta: { min, actual } }) : undefined;
    }, message);
  }

  /** Gives `too_long` where the string has more code points than `max`. */
  maxLength(max: number, message?: string): this {
    return this.check((s) => {
      const actual = codePoints(s);
      return actual > max ? new Issue("too_long", { meta: { max, actual } }) : undefined;
    }, message);
  }

  /** Gives `invalid_length` where the string does not have exactly `length` code points. */
  fixedLength(length: number, message?: string): this {
    return this.check((s) => {
      const actual = codePoints(s);
      return actual !== length ? new Issue("invalid_length", { meta: { expected: length, actual } }) : undefined;
    }, message);
  }

  /** Gives `not_allowed`, the allowed strings in code point order, where the string is none of them. */
  oneOf(allowed: readonly string[], message?: string): this {
    distinct(allowed);
    const sorted = [...allowed].sort(compareValues);
    return this.check(
      (s) => (allowed.includes(s) ? undefined : new Issue("not_allowed", { meta: { allowed: sorted, actual: s } })),
      message,
    );
  }

  /** Gives `invalid_format.starts_with` unless the string starts with `prefix`. */
  startsWith(prefix: string, message?: string): this {
    return this.#format((s) => s.startsWith(prefix), "starts_with", { prefix }, message);
  }

  /** Gives `invalid_format.ends_with` unless the string ends with `suffix`. */
  endsWith(suffix: string, message?: string): this {
    return this.#format((s) => s.endsWith(suffix), "ends_with", { suffix }, message);
  }

  /** Gives `invalid_format.includes` unless the string includes `substring`. */
  includes(substring: string, message?: string): this {
    return this.#format((s) => s.includes(substring), "includes", { substring }, message);
  }

  /** Gives `invalid_format.email` unless the string is an e-mail address of RFC 5321's ASCII profile. */
  email(message?: string): this {
    return this.#format(isEmail, "email", {}, message);
  }

  /** Gives `invalid_format.ipv4` unless the string is an IPv4 address. */
  ipv4(message?: string): this {
    return this.#format(isIpv4, "ipv4", {}, message);
  }

  /** Gives `invalid_format.ipv6` unless the string is an IPv6 address, with a zone only where one is allowed. */
  ipv6(message?: string): this {
    return this.#format(isIpv6, "ipv6", {}, message);
  }

  /** Gives `invalid_format.ip` unless the string is an IPv4 or an IPv6 address. */
  ip(message?: string): this {
    return this.#format((s) => isIpv4(s) || isIpv6(s), "ip", {}, message);
  }

  /** Gives `invalid_format.ulid` unless the string is a ULID; the string is given as it is. */
  ulid(message?: string): this {
    return this.#format(isUlid, "ulid", {}, message);
  }

  /** Gives `invalid_format.cuid` unless the string is a CUID of version 1. */
  cuid(message?: string): this {
    return this.#format(isCuid, "cuid", {}, message);
  }

  /** Reads a UUID, in either case, and gives it in lower case; anything else gives `invalid_format.uuid`. */
  uuid(message?: string): Chain<string> {
    return new Chain(
      this.convert((s) => (isUuid(s) ? ok(s.toLowerCase()) : failed(format("uuid"))), message),
    );
  }

  /** Reads an RFC 3986 URI, as written; anything else gives `invalid_format.uri`. */
  uri(message?: string): Chain<string> {
    return new Chain(this.convert((s) => (uriParts(s) !== undefined ? ok(s) : failed(format("uri"))), message));
  }

  /** Reads an http or https URI with a non-empty host; anything else gives `invalid_format.url`. */
  url(message?: string): Chain<string> {
    return new Chain(
      this.convert((s) => {
        const parts = uriParts(s);
        const scheme = parts?.scheme.toLowerCase();
        const web = (scheme === "http" || scheme === "https") && parts?.host !== undefined && parts.host !== "";
        return web ? ok(s) : failed(format("url"));
      }, message),
    );
  }

  /** Reads an int32 written with an optional sign and ASCII digits. */
  toInt(message?: string): IntDecoder {
    return new IntDecoder(this.convert((s) => textInteger(s, "integer", INT32_MIN, INT32_MAX, Number), message));
  }

  /** Reads an int64 written with an optional sign and ASCII digits. */
  toLong(message?: string): LongDecoder {
    return new LongDecoder(this.convert((s) => textInteger(s, "long", INT64_MIN, INT64_MAX, (n) => n), message));
  }

  /** Reads a decimal, keeping the scale it is written with. */
  toDecimal(message?: string): DecimalDecoder {
    return new DecimalDecoder(
      this.convert((s) => {
        const decimal = Decimal.parse(s);
        return decimal === undefined ? failed(textMismatch("decimal")) : ok(decimal);
      }, message),
    );
  }

  /** Reads true, 1, yes or on as true and false, 0, no or off as false, in either case of ASCII. */
  toBool(message?: string): BoolDecoder {
    return new BoolDecoder(
      this.convert((s) => {
        const word = /^[A-Za-z01]{1,5}$/.test(s) ? s.toLowerCase() : "";
        if (word === "true" || word === "1" || word === "yes" || word === "on") {
          return ok(true);
        }
        if (word === "false" || word === "0" || word === "no" || word === "off") {
          return ok(false);
        }
        return failed(textMismatch("boolean"));
      }, message),
    );
  }

  #format(test: (s: string) => boolean, kind: string, meta: Record<string, unknown>, message: string | undefined): this {
    return this.check((s) => (test(s) ? undefined : format(kind, meta)), message);
  }
}

function format(kind: string, meta: Record<string, unknown> = {}): Issue {
  return new Issue("invalid_format", { messageKey: `invalid_format.${kind}`, meta });
}

/** The `type_mismatch` of a string that does not read as the kind expected, which has no `actual`: the string was the kind expected. */
function textMismatch(expected: string): Issue {
  return new Issue("type_mismatch", { meta: { expected } });
}

function textInteger<N>(s: string, expected: string, min: bigint, max: bigint, as: (n: bigint) => N): Result<N> {
  if (!/^[+-]?[0-9]+$/.test(s)) {
    return failed(textMismatch(expected));
  }
  const value = BigInt(s);
  return value < min || value > max ? failed(numericRange(expected)) : ok(as(value));
}

/** How the values a numeric decoder reads are ordered and held in an issue's metadata. */
interface Arithmetic<T> {
  compare(a: T, b: T): number;
  meta(value: T): unknown;
  /** The least value `positive` allows, and the greatest `negative` allows, as metadata. */
  readonly positiveMin: unknown;
  readonly negativeMax: unknown;
  readonly zero: T;
}

/** A decoder of numbers, with the operations that bound them. */
export abstract class BoundedDecoder<T> extends Chain<T> {
  protected abstract get arithmetic(): Arithmetic<T>;

  metaValue(value: T): unknown {
    return this.arithmetic.meta(value);
  }

  /** Gives `out_of_range.minimum` where the value is less than `min`. */
  min(min: T, message?: string): this {
    const a = this.arithmetic;
    return this.check(
      (v) => (a.compare(v, min) < 0 ? outOfRange("minimum", { min: a.meta(min), actual: a.meta(v) }) : undefined),
      message,
    );
  }

  /** Gives `out_of_range.maximum` where the value is greater than `max`. */
  max(max: T, message?: string): this {
    const a = this.arithmetic;
    return this.check(
      (v) => (a.compare(v, max) > 0 ? outOfRange("maximum", { max: a.meta(max), actual: a.meta(v) }) : undefined),
      message,
    );
  }

  /** Gives `out_of_range.range` where the value is outside [min, max]. */
  range(min: T, max: T, message?: string): this {
    const a = this.arithmetic;
    if (a.compare(min, max) > 0) {
      throw new RangeError("the lower bound of a range is not greater than the upper");
    }
    return this.check(
      (v) =>
        a.compare(v, min) < 0 || a.compare(v, max) > 0
          ? outOfRange("range", { min: a.meta(min), max: a.meta(max), actual: a.meta(v) })
          : undefined,
      message,
    );
  }

  /** Gives `out_of_range.positive` unless the value is greater than zero. */
  positive(message?: string): this {
    const a = this.arithmetic;
    return this.check(
      (v) => (a.compare(v, a.zero) > 0 ? undefined : outOfRange("positive", { min: a.positiveMin, actual: a.meta(v) })),
      message,
    );
  }

  /** Gives `out_of_range.negative` unless the value is less than zero; -0 is. */
  negative(message?: string): this {
    const a = this.arithmetic;
    return this.check(
      (v) => (a.compare(v, a.zero) < 0 ? undefined : outOfRange("negative", { max: a.negativeMax, actual: a.meta(v) })),
      message,
    );
  }

  /** Gives `out_of_range.non_negative` where the value is less than zero; -0 is. */
  nonNegative(message?: string): this {
    const a = this.arithmetic;
    return this.check(
      (v) => (a.compare(v, a.zero) < 0 ? outOfRange("non_negative", { min: a.meta(a.zero), actual: a.meta(v) }) : undefined),
      message,
    );
  }

  /** Gives `out_of_range.non_positive` where the value is greater than zero. */
  nonPositive(message?: string): this {
    const a = this.arithmetic;
    return this.check(
      (v) => (a.compare(v, a.zero) > 0 ? outOfRange("non_positive", { max: a.meta(a.zero), actual: a.meta(v) }) : undefined),
      message,
    );
  }

  /** `oneOf` for the numeric decoders that have it. */
  protected allowing(allowed: readonly T[], message: string | undefined): this {
    const a = this.arithmetic;
    const held = allowed.map((v) => a.meta(v));
    distinct(held);
    const sorted = [...allowed].sort((x, y) => a.compare(x, y)).map((v) => a.meta(v));
    return this.check(
      (v) => (includesSame(held, a.meta(v)) ? undefined : new Issue("not_allowed", { meta: { allowed: sorted, actual: a.meta(v) } })),
      message,
    );
  }

  /** `multipleOf` for the numeric decoders that have it. */
  protected multiples(divisor: T, isMultiple: (value: T) => boolean, message: string | undefined): this {
    const a = this.arithmetic;
    if (a.compare(divisor, a.zero) === 0) {
      throw new RangeError("the divisor of multipleOf is not zero");
    }
    return this.check(
      (v) => (isMultiple(v) ? undefined : new Issue("not_multiple_of", { meta: { divisor: a.meta(divisor), actual: a.meta(v) } })),
      message,
    );
  }
}

function outOfRange(kind: string, meta: Record<string, unknown>): Issue {
  return new Issue("out_of_range", { messageKey: `out_of_range.${kind}`, meta });
}

function distinct(values: readonly unknown[]): void {
  values.forEach((value, i) => {
    if (includesSame(values.slice(0, i), value)) {
      throw new RangeError(`${String(value)} is allowed twice`);
    }
  });
}

const INT32: Arithmetic<number> = {
  compare: (a, b) => a - b,
  meta: (v) => v,
  positiveMin: 1,
  negativeMax: -1,
  zero: 0,
};

/** A decoder of int32 values, as JavaScript numbers. */
export class IntDecoder extends BoundedDecoder<number> {
  protected get arithmetic(): Arithmetic<number> {
    return INT32;
  }

  /** Gives `not_allowed`, the allowed values in ascending order, where the value is none of them. */
  oneOf(allowed: readonly number[], message?: string): this {
    return this.allowing(allowed, message);
  }

  /** Gives `not_multiple_of` where the value is not a multiple of `divisor`. */
  multipleOf(divisor: number, message?: string): this {
    return this.multiples(divisor, (v) => v % divisor === 0, message);
  }
}

const INT64: Arithmetic<bigint> = {
  compare: (a, b) => (a < b ? -1 : a > b ? 1 : 0),
  meta: (v) => v,
  positiveMin: 1n,
  negativeMax: -1n,
  zero: 0n,
};

/** A decoder of int64 values, as bigints. */
export class LongDecoder extends BoundedDecoder<bigint> {
  protected get arithmetic(): Arithmetic<bigint> {
    return INT64;
  }

  /** Gives `not_allowed`, the allowed values in ascending order, where the value is none of them. */
  oneOf(allowed: readonly bigint[], message?: string): this {
    return this.allowing(allowed, message);
  }

  /** Gives `not_multiple_of` where the value is not a multiple of `divisor`. */
  multipleOf(divisor: bigint, message?: string): this {
    return this.multiples(divisor, (v) => v % divisor === 0n, message);
  }
}

function floatArithmetic(width: Width): Arithmetic<number> {
  return {
    compare: (a, b) => compareValues(a, b),
    meta: (v) => new Float(v, width),
    positiveMin: new Float(0, width),
    negativeMax: new Float(0, width),
    zero: 0,
  };
}

const FLOAT32 = floatArithmetic(32);
const FLOAT64 = floatArithmetic(64);

/**
 * A decoder of float32 values, as JavaScript numbers holding a float32 value. Bounds are compared
 * in the float order of the value model, in which -0 is less than +0 and NaN is the greatest.
 */
export class FloatDecoder extends BoundedDecoder<number> {
  protected get arithmetic(): Arithmetic<number> {
    return FLOAT32;
  }

  min(min: number, message?: string): this {
    return super.min(Math.fround(min), message);
  }

  max(max: number, message?: string): this {
    return super.max(Math.fround(max), message);
  }

  range(min: number, max: number, message?: string): this {
    return super.range(Math.fround(min), Math.fround(max), message);
  }

  /** Gives `not_allowed`, the allowed values in the float order, where the value is none of them. */
  oneOf(allowed: readonly number[], message?: string): this {
    return this.allowing(allowed.map(Math.fround), message);
  }
}

/** A decoder of float64 values. Bounds are compared in the float order of the value model. */
export class DoubleDecoder extends BoundedDecoder<number> {
  protected get arithmetic(): Arithmetic<number> {
    return FLOAT64;
  }

  /** Gives `not_allowed`, the allowed values in the float order, where the value is none of them. */
  oneOf(allowed: readonly number[], message?: string): this {
    return this.allowing(allowed, message);
  }
}

const DECIMAL: Arithmetic<Decimal> = {
  compare: (a, b) => a.compare(b),
  meta: (v) => v,
  positiveMin: Decimal.of(0),
  negativeMax: Decimal.of(0),
  zero: Decimal.of(0),
};

/** A decoder of decimals, which keep the scale they are written with; bounds compare them by value. */
export class DecimalDecoder extends BoundedDecoder<Decimal> {
  protected get arithmetic(): Arithmetic<Decimal> {
    return DECIMAL;
  }

  /** Gives `not_multiple_of` where the value is not an integer multiple of `divisor`. */
  multipleOf(divisor: Decimal, message?: string): this {
    return this.multiples(divisor, (v) => v.isMultipleOf(divisor), message);
  }

  /** Gives `invalid_scale` where the decimal's scale is greater than `max`. */
  scale(max: number, message?: string): this {
    return this.check(
      (v) => (v.scale > max ? new Issue("invalid_scale", { meta: { maxScale: max, actualScale: v.scale } }) : undefined),
      message,
    );
  }
}

/** A decoder of booleans. */
export class BoolDecoder extends Chain<boolean> {
  /** Gives `invalid_value`, expected true, for false. */
  isTrue(message?: string): this {
    return this.check(
      (v) => (v ? undefined : new Issue("invalid_value", { meta: { expected: true, actual: false } })),
      message,
    );
  }
}

/** A decoder of strings: a JSON string. */
export function string(): StringDecoder {
  return new StringDecoder(scalar("string", "string", (input) => ok(input as string)));
}

/** A decoder of int32 values: a JSON number written as an integer, within the int32 range. */
export function int(): IntDecoder {
  return new IntDecoder(
    scalar("integer", "number", (input) => {
      const read = integer(input, "integer", INT32_MIN, INT32_MAX);
      return read.issues === undefined ? ok(Number(read.value)) : read;
    }),
  );
}

/** A decoder of int64 values: a JSON number written as an integer, within the int64 range, as a bigint. */
export function long(): LongDecoder {
  return new LongDecoder(scalar("long", "number", (input) => integer(input, "long", INT64_MIN, INT64_MAX)));
}

/** A decoder of float32 values: any JSON number, rounded once to the nearest float32. */
export function float(): FloatDecoder {
  return new FloatDecoder(scalar("float", "number", (input) => floatOf(input, "float", 32)));
}

/** A decoder of float64 values: any JSON number, rounded once to the nearest float64. */
export function double(): DoubleDecoder {
  return new DoubleDecoder(scalar("double", "number", (input) => floatOf(input, "double", 64)));
}

/** A decoder of decimals: any JSON number, at the scale its lexeme gives. */
export function decimal(): DecimalDecoder {
  return new DecimalDecoder(
    scalar("number", "number", (input) => {
      const lexeme = lexemeOf(input);
      const value = lexeme === undefined ? undefined : Decimal.parse(lexeme);
      return value === undefined ? failed(typeMismatch("number", input)) : ok(value);
    }),
  );
}

/** A decoder of booleans: a JSON boolean. */
export function bool(): BoolDecoder {
  return new BoolDecoder(scalar("boolean", "boolean", (input) => ok(input as boolean)));
}
