// Encoders: writing a value as JSON.

/** A value JSON can carry. */
export type Json = null | boolean | number | string | readonly Json[] | { readonly [member: string]: Json };

/** Writes a `T` as JSON. */
export interface Encoder<T> {
  encode(value: T): Json;
}

/** An encoder writing a string as a JSON string. */
export function string(): Encoder<string> {
  return { encode: (value) => value };
}

/** One member of an object encoder: its name, and what it writes for a value. */
export interface Property<T> {
  readonly name: string;
  write(value: T): Json;
}

/** A member `name` holding what `encoder` writes of what `getter` reads of the value. */
export function property<T, P>(name: string, getter: (value: T) => P, encoder: Encoder<P>): Property<T> {
  return { name, write: (value) => encoder.encode(getter(value)) };
}

/**
 * A member `name` holding what `encoder` writes of what `getter` reads of the value, or of
 * `fallback` where it reads null or undefined.
 */
export function propertyWithDefault<T, P>(
  name: string,
  getter: (value: T) => P | null | undefined,
  encoder: Encoder<P>,
  fallback: P,
): Property<T> {
  return {
    name,
    write: (value) => {
      const read = getter(value);
      return encoder.encode(read === null || read === undefined ? fallback : read);
    },
  };
}

/**
 * An encoder writing a JSON object with one member per property, in the order declared.
 *
 * @throws {RangeError} where two properties write the same member
 */
export function object<T>(...properties: readonly Property<T>[]): Encoder<T> {
  const names = new Set<string>();
  for (const { name } of properties) {
    if (names.has(name)) {
      throw new RangeError(`two properties write the member ${JSON.stringify(name)}`);
    }
    names.add(name);
  }
  return {
    encode: (value) => {
      const out: Record<string, Json> = {};
      for (const p of properties) {
        Object.defineProperty(out, p.name, { value: p.write(value), enumerable: true, writable: true, configurable: true });
      }
      return out;
    },
  };
}
