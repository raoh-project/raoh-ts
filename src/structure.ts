// The decoders that build structure: lists, maps, objects and their fields, and the choices
// between decoders.

import { Chain, Decoder, type Run, decoder } from "./decoder.ts";
import { isObject, kindOf, memberOf, membersOf } from "./input.ts";
import { Issue, Issues, type Result, failed, ok } from "./issue.ts";
import { compareCodePoints, includesSame, keyOf, same } from "./meta.ts";
import type { Path } from "./path.ts";
import { string } from "./scalars.ts";
import { ValueSet } from "./set.ts";

const REQUIRED = new Issue("required");

function typeMismatch(expected: string, input: unknown): Issue {
  return new Issue("type_mismatch", { meta: { expected, actual: kindOf(input) } });
}

/** What a decoder's step gives: absent or null is `required`, another kind than `kind` a `type_mismatch`. */
function present(input: unknown, path: Path, kind: string, expected: string): Issue | undefined {
  if (input === undefined || input === null) {
    return REQUIRED.under(path);
  }
  return kindOf(input) === kind ? undefined : typeMismatch(expected, input).under(path);
}

/** Every value's result, as one: the values where all succeeded, and otherwise every issue in order. */
function gathered<T>(results: readonly Result<T>[]): Result<T[]> {
  const issues: Issue[] = [];
  const values: T[] = [];
  for (const result of results) {
    if (result.issues === undefined) {
      values.push(result.value);
    } else {
      issues.push(...result.issues);
    }
  }
  return issues.length > 0 ? failed(issues) : ok(values);
}

/** A decoder of lists, with the operations on lists. */
export class ListDecoder<E> extends Chain<E[]> {
  readonly #element: Decoder<E>;

  constructor(run: Run<E[]>, element: Decoder<E>) {
    super(run);
    this.#element = element;
  }

  protected derive(run: Run<E[]>): this {
    return new ListDecoder(run, this.#element) as this;
  }

  metaValue(value: E[]): unknown {
    return value.map((element) => this.#element.metaValue(element));
  }

  /** Gives `too_small.nonempty` where there is no element. */
  nonempty(message?: string): this {
    return this.check(
      (list) =>
        list.length === 0 ? new Issue("too_small", { messageKey: "too_small.nonempty", meta: { min: 1, actual: 0 } }) : undefined,
      message,
    );
  }

  /** Gives `too_small` where there are fewer than `min` elements. */
  minSize(min: number, message?: string): this {
    return this.check(
      (list) => (list.length < min ? new Issue("too_small", { meta: { min, actual: list.length } }) : undefined),
      message,
    );
  }

  /** Gives `too_big` where there are more than `max` elements. */
  maxSize(max: number, message?: string): this {
    return this.check(
      (list) => (list.length > max ? new Issue("too_big", { meta: { max, actual: list.length } }) : undefined),
      message,
    );
  }

  /** Gives `invalid_size` unless there are exactly `size` elements. */
  fixedSize(size: number, message?: string): this {
    return this.check(
      (list) => (list.length !== size ? new Issue("invalid_size", { meta: { expected: size, actual: list.length } }) : undefined),
      message,
    );
  }

  /**
   * Gives `duplicate_element` where an element occurs more than once, compared as the value model
   * compares them. `duplicates` lists each such element once, in the order of the occurrences that
   * first make them duplicates.
   */
  unique(message?: string): this {
    return this.check((list) => {
      const duplicates = duplicatesIn(list);
      return duplicates.length > 0
        ? new Issue("duplicate_element", { meta: { duplicates: duplicates.map((d) => this.#element.metaValue(d)) } })
        : undefined;
    }, message);
  }

  /** Gives `missing_element` unless `element` occurs, compared as the value model compares them. */
  contains(element: E, message?: string): this {
    return this.check(
      (list) =>
        includesSame(list, element)
          ? undefined
          : new Issue("missing_element", { meta: { expected: this.#element.metaValue(element) } }),
      message,
    );
  }

  /**
   * Gives `missing_elements` unless every element of `elements` occurs; `missing` lists, in the
   * order given, each that does not, as many times as it was given.
   */
  containsAll(elements: readonly E[], message?: string): this {
    if (elements.length === 0) {
      throw new RangeError("containsAll takes at least one element");
    }
    return this.check((list) => {
      const missing = elements.filter((element) => !includesSame(list, element));
      const held = (values: readonly E[]) => values.map((value) => this.#element.metaValue(value));
      return missing.length > 0
        ? new Issue("missing_elements", { meta: { expected: held(elements), missing: held(missing) } })
        : undefined;
    }, message);
  }

  /** A decoder giving the set of the elements, compared as the value model compares them. */
  toSet(): Decoder<ValueSet<E>> {
    return new Chain(this.convert((list) => ok(ValueSet.of(list))));
  }
}

/** The elements that occur more than once, each once, in the order their second occurrences come in. */
function duplicatesIn<E>(list: readonly E[]): E[] {
  const duplicates: E[] = [];
  const seen: E[] = [];
  const seenKeys = new Set<string>();
  const reported = new Set<string>();
  for (const element of list) {
    const key = keyOf(element);
    if (key !== undefined) {
      if (seenKeys.has(key) && !reported.has(key)) {
        duplicates.push(element);
        reported.add(key);
      }
      seenKeys.add(key);
      continue;
    }
    if (seen.some((other) => same(other, element)) && !includesSame(duplicates, element)) {
      duplicates.push(element);
    }
    seen.push(element);
  }
  return duplicates;
}

/** A decoder of a JSON array, each element read with `element` at the path of its index. */
export function list<E>(element: Decoder<E>): ListDecoder<E> {
  return new ListDecoder((input, path) => {
    const wrong = present(input, path, "array", "array");
    if (wrong !== undefined) {
      return failed(wrong);
    }
    return gathered((input as unknown[]).map((item, i) => element.decodeAt(item, path.child(i))));
  }, element);
}

/** A decoder of maps, with the operations on maps. */
export class DictDecoder<E> extends Chain<Map<string, E>> {
  /** Gives `too_small.nonempty` where there is no member. */
  nonempty(message?: string): this {
    return this.check(
      (map) =>
        map.size === 0 ? new Issue("too_small", { messageKey: "too_small.nonempty", meta: { min: 1, actual: 0 } }) : undefined,
      message,
    );
  }

  /** Gives `too_small` where there are fewer than `min` members. */
  minSize(min: number, message?: string): this {
    return this.check(
      (map) => (map.size < min ? new Issue("too_small", { meta: { min, actual: map.size } }) : undefined),
      message,
    );
  }

  /** Gives `too_big` where there are more than `max` members. */
  maxSize(max: number, message?: string): this {
    return this.check(
      (map) => (map.size > max ? new Issue("too_big", { meta: { max, actual: map.size } }) : undefined),
      message,
    );
  }

  /** Gives `invalid_size` unless there are exactly `size` members. */
  fixedSize(size: number, message?: string): this {
    return this.check(
      (map) => (map.size !== size ? new Issue("invalid_size", { meta: { expected: size, actual: map.size } }) : undefined),
      message,
    );
  }
}

/** A decoder of a JSON object, each member's value read with `value` at the path of its name, in a `Map` in member order. */
export function dict<E>(value: Decoder<E>): DictDecoder<E> {
  return new DictDecoder((input, path) => {
    const wrong = present(input, path, "object", "object");
    if (wrong !== undefined) {
      return failed(wrong);
    }
    const members = membersOf(input as object);
    const read = gathered(members.map(([name, member]) => value.decodeAt(member, path.child(name))));
    return read.issues === undefined ? ok(new Map(members.map(([name], i) => [name, read.value[i] as E]))) : read;
  });
}

/** A field of an object decoder: what it reads of the object, and the member it names, if one. */
export class Field<T> {
  readonly #run: Run<T>;
  /** The member the field reads; `undefined` for a flat field, which reads the whole input. */
  readonly name: string | undefined;

  constructor(name: string | undefined, run: Run<T>) {
    this.name = name;
    this.#run = run;
  }

  /** Reads the field of `input`, which is the object at `path`. */
  readAt(input: unknown, path: Path): Result<T> {
    return this.#run(input, path);
  }
}

/**
 * A required field: the member `name` read with `decoder` at the member's path, an absent member
 * handed to it as absent. Where the input is not an object, `type_mismatch` (expected `object`)
 * at the member's path.
 */
export function field<T>(name: string, decoder: Decoder<T>): Field<T> {
  return new Field(name, (input, path) => {
    const at = path.child(name);
    if (!isObject(input)) {
      return failed(typeMismatch("object", input).under(at));
    }
    return decoder.decodeAt(memberOf(input, name), at);
  });
}

/** An optional field: `undefined` where the member is absent or the input is not an object, and otherwise the member read with `decoder`. */
export function optionalField<T>(name: string, decoder: Decoder<T>): Field<T | undefined> {
  return new Field(name, (input, path) => {
    const member = isObject(input) ? memberOf(input, name) : undefined;
    return member === undefined ? ok(undefined) : decoder.decodeAt(member, path.child(name));
  });
}

/** Whether a member was absent, null, or present with a value. */
export type Presence<T> =
  | { readonly state: "absent" }
  | { readonly state: "null" }
  | { readonly state: "present"; readonly value: T };

/** The presence of a member that is not there. */
export const ABSENT: Presence<never> = Object.freeze({ state: "absent" });

/** The presence of a member that is JSON null. */
export const NULL: Presence<never> = Object.freeze({ state: "null" });

/** The presence of a member that has a value. */
export function presentWith<T>(value: T): Presence<T> {
  return { state: "present", value };
}

/**
 * A field that tells absence from null: absent where the member is absent or the input is not an
 * object, null where the member is JSON null, and otherwise the member read with `decoder`.
 */
export function optionalNullableField<T>(name: string, decoder: Decoder<T>): Field<Presence<T>> {
  return new Field(name, (input, path) => {
    const member = isObject(input) ? memberOf(input, name) : undefined;
    if (member === undefined) {
      return ok(ABSENT);
    }
    if (member === null) {
      return ok(NULL);
    }
    const read = decoder.decodeAt(member, path.child(name));
    return read.issues === undefined ? ok(presentWith(read.value)) : read;
  });
}

/** A field that reads the whole input with `decoder`, not a member of it. */
export function flat<T>(decoder: Decoder<T>): Field<T> {
  return new Field(undefined, (input, path) => decoder.decodeAt(input, path));
}

type Values<F extends readonly Field<unknown>[]> = { -readonly [K in keyof F]: F[K] extends Field<infer T> ? T : never };

/**
 * A decoder of objects, giving the values of its fields in the order they are declared. Every
 * field is read and every failing one's issues given, in that order.
 */
export class ObjectDecoder<T extends readonly unknown[]> extends Chain<T> {
  readonly #fields: readonly Field<unknown>[];

  constructor(fields: readonly Field<unknown>[]) {
    super((input, path) => gathered(fields.map((f) => f.readAt(input, path))) as Result<T>);
    this.#fields = fields;
  }

  /**
   * This decoder, giving `unknown_field` for every member of an object input that no field names.
   *
   * @throws {TypeError} where a field is flat, since the members it reads cannot be told
   */
  strict(): Decoder<T> {
    const names = this.#fields.map((f) => {
      if (f.name === undefined) {
        throw new TypeError("a strict object cannot have a flat field");
      }
      return f.name;
    });
    return strict(this, names);
  }
}

/** A decoder of objects whose fields are `fields`, giving their values as a tuple, in order. */
export function object<const F extends readonly Field<unknown>[]>(...fields: F): ObjectDecoder<Values<F>> {
  return new ObjectDecoder(fields);
}

/**
 * `inner`, and where the input is an object, `unknown_field` at every member not among `known`
 * that `inner` has not already reported unknown, in member order, after `inner`'s issues. Nested,
 * the innermost that does not know a member reports it, and only members every one knows are
 * accepted.
 */
export function strict<T>(inner: Decoder<T>, known: readonly string[]): Decoder<T> {
  const knownNames = new Set(known);
  return decoder((input, path) => {
    const read = inner.decodeAt(input, path);
    if (!isObject(input)) {
      return read;
    }
    const before = read.issues?.list ?? [];
    const unknown: Issue[] = [];
    for (const [name] of membersOf(input)) {
      if (knownNames.has(name)) {
        continue;
      }
      const at = path.child(name);
      if (before.some((issue) => issue.messageKey === "unknown_field" && issue.path.equals(at))) {
        continue;
      }
      unknown.push(new Issue("unknown_field", { meta: { field: name } }).under(at));
    }
    return unknown.length === 0 ? read : failed([...before, ...unknown]);
  });
}

/** What `enumOf` and `literal` are made with, beside their values. */
export interface ReadWith {
  /** The decoder the string is read with; `string()` when none is given. */
  readonly string?: Decoder<string>;
  /** The sentence of the issue the decoder gives itself. */
  readonly message?: string;
}

/**
 * A decoder of one of `symbols`: the string `options.string` reads, matched with A-Z read as a-z,
 * given as the symbol is declared. Anything else gives `invalid_format.enum`, listing the symbols
 * lower-cased, in code point order.
 *
 * @throws {RangeError} where two symbols are the same once A-Z are read as a-z
 */
export function enumOf<const S extends readonly string[]>(symbols: S, options: ReadWith = {}): Decoder<S[number]> {
  const byFolded = new Map<string, S[number]>();
  for (const symbol of symbols) {
    const folded = asciiLower(symbol);
    if (byFolded.has(folded)) {
      throw new RangeError(`${symbol} is the same symbol as ${byFolded.get(folded)} with A-Z read as a-z`);
    }
    byFolded.set(folded, symbol);
  }
  const allowed = [...byFolded.keys()].sort(compareCodePoints);
  return chained(options.string ?? string(), options.message, (s) => {
    const symbol = byFolded.get(asciiLower(s));
    return symbol === undefined
      ? failed(new Issue("invalid_format", { messageKey: "invalid_format.enum", meta: { allowed } }))
      : ok(symbol);
  });
}

/** A decoder of the string `expected`, read with `options.string`; anything else gives `invalid_format.literal`. */
export function literal<const L extends string>(expected: L, options: ReadWith = {}): Decoder<L> {
  return chained(options.string ?? string(), options.message, (s) =>
    s === expected
      ? ok(expected)
      : failed(new Issue("invalid_format", { messageKey: "invalid_format.literal", meta: { expected } })),
  );
}

/** `first`, then `f` of its value, the issues `f` gives at the decoder's path with `message` as their sentence where one is given. */
function chained<S, T>(first: Decoder<S>, message: string | undefined, f: (value: S) => Result<T>): Decoder<T> {
  return decoder((input, path) => {
    const read = first.decodeAt(input, path);
    if (read.issues !== undefined) {
      return read;
    }
    const made = f(read.value);
    if (made.issues === undefined) {
      return made;
    }
    const issues = message === undefined ? made.issues.list : made.issues.list.map((issue) => issue.withMessage(message));
    return failed(new Issues(issues).under(path));
  });
}

function asciiLower(s: string): string {
  return s.replace(/[A-Z]+/g, (upper) => upper.toLowerCase());
}

type Variants = Readonly<Record<string, Decoder<unknown>>>;
type VariantValue<V extends Variants> = { [K in keyof V]: V[K] extends Decoder<infer T> ? T : never }[keyof V];

function notAllowed(variants: Variants): Issue {
  return new Issue("not_allowed", { meta: { allowed: Object.keys(variants).sort(compareCodePoints) } });
}

function variantFor(variants: Variants, tag: string): Decoder<unknown> | undefined {
  return Object.prototype.hasOwnProperty.call(variants, tag) ? variants[tag] : undefined;
}

/**
 * A decoder of the variant the member `fieldName` names: the tag read as a string, and the whole
 * input read with that variant. A tag that names none gives `not_allowed` at the tag's path, the
 * variants' names in code point order.
 */
export function discriminate<const V extends Variants>(fieldName: string, variants: V): Decoder<VariantValue<V>> {
  const tag = field(fieldName, string());
  return decoder((input, path) => {
    const read = tag.readAt(input, path);
    if (read.issues !== undefined) {
      return read;
    }
    const variant = variantFor(variants, read.value);
    if (variant === undefined) {
      return failed(notAllowed(variants).under(path.child(fieldName)));
    }
    return variant.decodeAt(input, path) as Result<VariantValue<V>>;
  });
}

/**
 * As {@link discriminate}, the tag being what `tag` gives for the whole input, its issues given
 * as they are; a tag that names no variant gives `not_allowed` at the path of `fieldName`.
 */
export function discriminateBy<const V extends Variants>(
  fieldName: string,
  tag: Decoder<string>,
  variants: V,
): Decoder<VariantValue<V>> {
  return decoder((input, path) => {
    const read = tag.decodeAt(input, path);
    if (read.issues !== undefined) {
      return read;
    }
    const variant = variantFor(variants, read.value);
    if (variant === undefined) {
      return failed(notAllowed(variants).under(path.child(fieldName)));
    }
    return variant.decodeAt(input, path) as Result<VariantValue<V>>;
  });
}

type Candidate<D> = D extends Decoder<infer T> ? T : never;

/**
 * A decoder trying each candidate in turn on the same input, giving the first success. Where all
 * fail, `one_of_failed` at the input's path, its `candidates` listing each one's issues by index.
 */
export function oneOf<const D extends readonly Decoder<unknown>[]>(...candidates: D): Decoder<Candidate<D[number]>> {
  if (candidates.length === 0) {
    throw new RangeError("oneOf takes at least one decoder");
  }
  return decoder((input, path) => {
    const failures: { candidate: number; issues: Issues }[] = [];
    for (const [index, candidate] of candidates.entries()) {
      const read = candidate.decodeAt(input, path);
      if (read.issues === undefined) {
        return read as Result<Candidate<D[number]>>;
      }
      failures.push({ candidate: index, issues: read.issues });
    }
    return failed(new Issue("one_of_failed", { meta: { candidates: failures } }).under(path));
  });
}
