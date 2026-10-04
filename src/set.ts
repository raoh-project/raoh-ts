// A set of values compared as the value model compares them.

import { keyOf, same } from "./meta.ts";
import { ofThisCopy, tagOf } from "./copy.ts";

/**
 * A finite set whose members are told apart as the value model tells values apart: +0 and -0 are
 * two members, every NaN is one, and decimals, lists and other structured values are members by
 * what they hold, not by identity. A JavaScript `Set` compares by SameValueZero and identity, and
 * so holds neither.
 */
export class ValueSet<E> implements Iterable<E> {
  readonly #members: readonly E[];
  readonly #keys: ReadonlySet<string>;

  private constructor(members: readonly E[], keys: ReadonlySet<string>) {
    this.#members = members;
    this.#keys = keys;
  }

  /** The set of the values given, each kept the first time it occurs. */
  static of<E>(values: Iterable<E>): ValueSet<E> {
    const members: E[] = [];
    const keys = new Set<string>();
    for (const value of values) {
      const key = keyOf(value);
      if (key !== undefined) {
        if (keys.has(key)) {
          continue;
        }
        keys.add(key);
      } else if (members.some((member) => same(member, value))) {
        continue;
      }
      members.push(value);
    }
    return new ValueSet(Object.freeze(members), keys);
  }

  get [Symbol.toStringTag](): string {
    return tagOf("ValueSet");
  }

  get size(): number {
    return this.#members.length;
  }

  /** Whether `value` is a member. */
  has(value: E): boolean {
    const key = keyOf(value);
    return key !== undefined ? this.#keys.has(key) : this.#members.some((member) => same(member, value));
  }

  [Symbol.iterator](): Iterator<E> {
    return this.#members[Symbol.iterator]();
  }

  /** The members, in the order they were first given. */
  values(): readonly E[] {
    return this.#members;
  }

  /** Whether the two sets have the same members. */
  equals(other: unknown): boolean {
    return ofThisCopy(other, ValueSet, "ValueSet") && other.size === this.size && this.#members.every((member) => other.has(member));
  }

  toJSON(): readonly E[] {
    return this.#members;
  }
}
