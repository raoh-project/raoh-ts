// Values of the value model: how they are compared, ordered and written in a message.

import { Decimal } from "./decimal.ts";
import { Float, compareFloats } from "./float.ts";

/**
 * Whether the two are the same value of the value model: floats as `Object.is` compares them (+0
 * and -0 differ, NaN is NaN), a decimal by coefficient and scale, lists element by element, sets
 * and maps in any order.
 */
export function same(a: unknown, b: unknown): boolean {
  if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) {
    return Object.is(a, b);
  }
  if (a instanceof Decimal) {
    return b instanceof Decimal && a.equals(b);
  }
  if (a instanceof Float) {
    return b instanceof Float && a.width === b.width && Object.is(a.value, b.value);
  }
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((item, i) => same(item, b[i]));
  }
  if (a instanceof Set) {
    return b instanceof Set && a.size === b.size && [...a].every((item) => [...b].some((other) => same(item, other)));
  }
  if (a instanceof Map) {
    return (
      b instanceof Map &&
      a.size === b.size &&
      [...a].every(([key, value]) => b.has(key) && same(value, b.get(key)))
    );
  }
  const equals = (a as { equals?: unknown }).equals;
  if (typeof equals === "function") {
    return (equals as (other: unknown) => boolean).call(a, b);
  }
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) {
    return false;
  }
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(b, key) &&
        same((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
    )
  );
}

/**
 * A key two values share exactly when they are the same value, for the scalars that have one;
 * `undefined` for a value that has to be compared with {@link same}.
 */
export function keyOf(value: unknown): string | undefined {
  switch (typeof value) {
    case "string":
      return `s${value}`;
    case "boolean":
      return value ? "t" : "f";
    case "bigint":
      return `i${value}`;
    case "number":
      return Object.is(value, -0) ? "n-0" : `n${value}`;
    default:
      if (value === null) {
        return "z";
      }
      if (value instanceof Decimal) {
        return `d${value.coefficient}:${value.scale}`;
      }
      if (value instanceof Float) {
        return `f${value.width}:${Object.is(value.value, -0) ? "-0" : value.value}`;
      }
      return undefined;
  }
}

/** Whether `value` occurs in `values`, compared as the value model compares them. */
export function includesSame(values: readonly unknown[], value: unknown): boolean {
  return values.some((each) => same(each, value));
}

/** -1, 0 or 1 as `a` comes before, with or after `b`, for the values the bounding operations order. */
export function compareValues(a: unknown, b: unknown): number {
  if (typeof a === "string" && typeof b === "string") {
    return compareCodePoints(a, b);
  }
  if (typeof a === "bigint" && typeof b === "bigint") {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (typeof a === "number" && typeof b === "number") {
    return compareFloats(a, b);
  }
  if (a instanceof Float && b instanceof Float) {
    return compareFloats(a.value, b.value);
  }
  if (a instanceof Decimal && b instanceof Decimal) {
    return a.compare(b);
  }
  const compare = (a as { compare?: unknown } | null)?.compare;
  if (typeof compare === "function") {
    return (compare as (other: unknown) => number).call(a, b);
  }
  throw new TypeError(`${String(a)} and ${String(b)} have no order`);
}

/** -1, 0 or 1 as `a` comes before, with or after `b` in code point order, which UTF-16 order is not. */
export function compareCodePoints(a: string, b: string): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const x = a.codePointAt(i) as number;
    const y = b.codePointAt(i) as number;
    if (x !== y) {
      return x < y ? -1 : 1;
    }
    if (x > 0xffff) {
      i += 1;
    }
  }
  return a.length - b.length < 0 ? -1 : a.length > b.length ? 1 : 0;
}

/**
 * How a metadata value is written in a message: a boolean, an integer or a string as it is, a
 * float and a decimal in their message forms, a list as `[a, b]`, and a temporal value as its
 * `toString` writes it.
 */
export function messageForm(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(messageForm).join(", ")}]`;
  }
  if (typeof value === "object" && value !== null && !hasOwnToString(value)) {
    return JSON.stringify(value);
  }
  return String(value);
}

function hasOwnToString(value: object): boolean {
  return Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null;
}
