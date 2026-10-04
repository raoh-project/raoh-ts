// How issues and the values of the value model are written as JSON.
//
// There is one way, and it is the Raoh Specification's observation of a value
// (spec/observation.md): an integer is a JSON number of all its digits, a float its canonical
// decimal or, where JSON cannot carry it, a tag ({"float": "-0"}, {"float": "NaN"},
// {"float": "+Infinity"}, {"float": "-Infinity"}), a decimal the text of its coefficient and
// scale, a list an array, a record an object, and the issues of a one_of_failed an array of
// issues. Every number is held as a JsonNumber of the text to write, so none is rounded on the
// way out.

import { Decimal } from "./decimal.ts";
import { Float, floatJson } from "./float.ts";
import { JsonNumber, kindOf, lexemeOf } from "./input.ts";
import type { Issue } from "./issue.ts";
import { Issues } from "./issue.ts";
import { type MessageResolver, Messages } from "./messages.ts";
import { ValueSet } from "./set.ts";

/** A JSON value as this library writes one: every number a JsonNumber of its exact text. */
export type Wire = null | boolean | string | JsonNumber | readonly Wire[] | { readonly [member: string]: Wire };

/**
 * An issue held in another's metadata, the candidates of a `one_of_failed`, as the
 * specification observes the `issues` type: a path, a code, a message and metadata, and no
 * message key.
 */
export interface NestedIssueWire {
  readonly path: string;
  readonly code: string;
  readonly message: string;
  readonly meta: { readonly [name: string]: Wire };
}

/** An issue as JSON: a nested issue's parts, and its message key. */
export interface IssueWire extends NestedIssueWire {
  readonly messageKey: string;
}

/**
 * `issue` as JSON: its path as a JSON Pointer, its code, its message key, its sentence as
 * `resolver` writes it (or as it was given), and its metadata, each value as its observation.
 */
export function issueWire(issue: Issue, resolver: MessageResolver = Messages.english): IssueWire {
  const { path, code, message, meta } = nestedIssueWire(issue, resolver);
  return { path, code, messageKey: issue.messageKey, message, meta };
}

/** `issue` as JSON where it is held in another issue's metadata: everything but its message key. */
export function nestedIssueWire(issue: Issue, resolver: MessageResolver = Messages.english): NestedIssueWire {
  return {
    path: issue.path.toString(),
    code: issue.code,
    message: issue.message(resolver),
    meta: record(issue.meta, resolver),
  };
}

/**
 * A metadata value as its observation. A JavaScript number is an int32 where it is an integer
 * and a float64 otherwise; a value of another class is written as what its `toJSON` gives.
 */
export function wire(value: unknown, resolver: MessageResolver = Messages.english): Wire {
  switch (typeof value) {
    case "boolean":
    case "string":
      return value;
    case "bigint":
      return new JsonNumber(value.toString());
    case "number":
      return Number.isInteger(value) && !Object.is(value, -0) ? new JsonNumber(String(value)) : floatJson(value, 64);
    case "undefined":
      return null;
  }
  if (value === null || value instanceof JsonNumber) {
    return value;
  }
  // A number the input model reads from an object, which JSON.rawJSON makes, is written as the
  // number it is, by the one rule that reads it.
  if (kindOf(value) === "number") {
    return new JsonNumber(lexemeOf(value) as string);
  }
  if (value instanceof Float) {
    return floatJson(value.value, value.width);
  }
  if (value instanceof Decimal) {
    return value.toString();
  }
  if (value instanceof Issues) {
    return value.list.map((issue) => nestedIssueWire(issue, resolver) as unknown as Wire);
  }
  if (Array.isArray(value) || value instanceof ValueSet) {
    return [...value].map((item) => wire(item, resolver));
  }
  if (value instanceof Map) {
    return record(Object.fromEntries(value), resolver);
  }
  if (typeof value === "object") {
    const toJSON = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === "function") {
      return wire(toJSON.call(value), resolver);
    }
    return record(value as Record<string, unknown>, resolver);
  }
  throw new TypeError(`a ${typeof value} has no JSON`);
}

function record(fields: Readonly<Record<string, unknown>>, resolver: MessageResolver): { [name: string]: Wire } {
  const out: { [name: string]: Wire } = {};
  for (const [name, value] of Object.entries(fields)) {
    Object.defineProperty(out, name, { value: wire(value, resolver), enumerable: true, writable: true, configurable: true });
  }
  return out;
}
