// The types and values of the value model as the runner holds them, and their observations
// (spec/value-model.md, spec/observation.md).

import {
  ABSENT,
  Decimal,
  Instant,
  type Issue,
  JsonNumber,
  LocalDate,
  LocalDateTime,
  LocalTime,
  NULL,
  OffsetDateTime,
  type Presence,
  ValueSet,
  type Width,
  presentWith,
} from "../src/index.ts";
import { floatJson, nearestFloat } from "../src/float.ts";
import { issueWire, wire } from "../src/wire.ts";

/** A type of the value model, as catalog/operations.json writes one. */
export type Ty =
  | { readonly kind: "bool" | "int32" | "int64" | "float32" | "float64" | "decimal" | "string" | "uuid" | "uri" }
  | { readonly kind: "date" | "time" | "datetime" | "offset_datetime" | "instant" }
  | { readonly kind: "symbol"; readonly symbols: readonly string[] }
  | { readonly kind: "list" | "set" | "map" | "presence" | "optional" | "nullable"; readonly of: Ty }
  | { readonly kind: "product"; readonly parts: readonly Ty[] };

export const T = {
  bool: { kind: "bool" },
  int32: { kind: "int32" },
  int64: { kind: "int64" },
  float32: { kind: "float32" },
  float64: { kind: "float64" },
  decimal: { kind: "decimal" },
  string: { kind: "string" },
  uuid: { kind: "uuid" },
  uri: { kind: "uri" },
  list: (of: Ty): Ty => ({ kind: "list", of }),
  set: (of: Ty): Ty => ({ kind: "set", of }),
  map: (of: Ty): Ty => ({ kind: "map", of }),
  presence: (of: Ty): Ty => ({ kind: "presence", of }),
  optional: (of: Ty): Ty => ({ kind: "optional", of }),
  nullable: (of: Ty): Ty => ({ kind: "nullable", of }),
  product: (parts: readonly Ty[]): Ty => ({ kind: "product", parts }),
  symbol: (symbols: readonly string[]): Ty => ({ kind: "symbol", symbols }),
} as const satisfies Record<string, Ty | ((...args: never[]) => Ty)>;

/** Whether the two types are the same. */
export function sameType(a: Ty, b: Ty): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Thrown where a case needs what this runner does not bind. */
export class Unbound extends Error {}

function wrong(json: unknown, ty: Ty): Error {
  return new Error(`${String(json)} is not an observation of ${JSON.stringify(ty)}`);
}

/** Reads `json`, a node of the case file, as an observation of `ty`: a value argument or an encoder's input. */
export function read(ty: Ty, json: unknown): unknown {
  switch (ty.kind) {
    case "bool":
      if (typeof json !== "boolean") throw wrong(json, ty);
      return json;
    case "int32":
    case "int64": {
      if (!(json instanceof JsonNumber) || !/^-?[0-9]+$/.test(json.lexeme)) throw wrong(json, ty);
      const value = BigInt(json.lexeme);
      return ty.kind === "int32" ? Number(value) : value;
    }
    case "float32":
    case "float64":
      return readFloat(json, ty.kind === "float32" ? 32 : 64, ty);
    case "decimal": {
      const value = typeof json === "string" ? Decimal.parse(json) : undefined;
      if (value === undefined) throw wrong(json, ty);
      return value;
    }
    case "string":
    case "symbol":
    case "uuid":
    case "uri":
      if (typeof json !== "string") throw wrong(json, ty);
      return json;
    case "date":
    case "time":
    case "datetime":
    case "offset_datetime":
    case "instant": {
      const value = typeof json === "string" ? TEMPORALS[ty.kind].parse(json) : undefined;
      if (value === undefined) throw wrong(json, ty);
      return value;
    }
    case "list":
      if (!Array.isArray(json)) throw wrong(json, ty);
      return json.map((item) => read(ty.of, item));
    case "set":
      if (!Array.isArray(json)) throw wrong(json, ty);
      return ValueSet.of(json.map((item) => read(ty.of, item)));
    case "map":
      if (!(json instanceof Map)) throw wrong(json, ty);
      return new Map([...json].map(([k, v]) => [k, read(ty.of, v)]));
    case "product":
      if (!Array.isArray(json) || json.length !== ty.parts.length) throw wrong(json, ty);
      return json.map((item, i) => read(ty.parts[i] as Ty, item));
    case "presence":
      if (json === "absent") return ABSENT;
      if (json === "null") return NULL;
      if (json instanceof Map && json.size === 1 && json.has("present")) return presentWith(read(ty.of, json.get("present")));
      throw wrong(json, ty);
    case "optional":
      return json === null ? undefined : read(ty.of, json);
    case "nullable":
      return json === null ? null : read(ty.of, json);
  }
}

/** The class of each temporal type, whose `parse` reads its observation and whose `toString` writes it. */
const TEMPORALS = {
  date: LocalDate,
  time: LocalTime,
  datetime: LocalDateTime,
  offset_datetime: OffsetDateTime,
  instant: Instant,
} as const;

/** A float written as a JSON number, rounded to the width once, or as a tag. */
function readFloat(json: unknown, width: Width, ty: Ty): number {
  if (json instanceof JsonNumber) {
    const decimal = Decimal.parse(json.lexeme) as Decimal;
    const negative = json.lexeme.startsWith("-");
    return nearestFloat(negative, negative ? -decimal.coefficient : decimal.coefficient, -decimal.scale, width);
  }
  if (json instanceof Map && json.size === 1) {
    switch (json.get("float")) {
      case "-0":
        return -0;
      case "NaN":
        return NaN;
      case "+Infinity":
        return Infinity;
      case "-Infinity":
        return -Infinity;
    }
  }
  throw wrong(json, ty);
}

/**
 * Writes `value`, a value of `ty`, as its observation, ready for `JSON.stringify`. A scalar is
 * written as the library writes it; the type says only what a JavaScript value does not, which
 * float width a number is, and how a structure the library has no JSON of is observed.
 */
export function observe(ty: Ty, value: unknown): unknown {
  const mismatch = () => new Error(`${String(value)} is not a value of ${JSON.stringify(ty)}`);
  switch (ty.kind) {
    case "bool":
      if (typeof value !== "boolean") throw mismatch();
      return value;
    case "int32":
      if (typeof value !== "number" || !Number.isInteger(value)) throw mismatch();
      return wire(value);
    case "int64":
      if (typeof value !== "bigint") throw mismatch();
      return wire(value);
    case "float32":
    case "float64":
      if (typeof value !== "number") throw mismatch();
      return floatJson(value, ty.kind === "float32" ? 32 : 64);
    case "decimal":
      if (!(value instanceof Decimal)) throw mismatch();
      return wire(value);
    case "string":
    case "symbol":
    case "uuid":
    case "uri":
      if (typeof value !== "string") throw mismatch();
      return value;
    case "date":
    case "time":
    case "datetime":
    case "offset_datetime":
    case "instant":
      if (!(value instanceof TEMPORALS[ty.kind])) throw mismatch();
      return String(value);
    case "list":
      if (!Array.isArray(value)) throw mismatch();
      return value.map((item) => observe(ty.of, item));
    case "product":
      if (!Array.isArray(value) || value.length !== ty.parts.length) throw mismatch();
      return value.map((item, i) => observe(ty.parts[i] as Ty, item));
    case "set":
      if (!(value instanceof ValueSet)) throw mismatch();
      return [...value].map((item) => observe(ty.of, item));
    case "map": {
      if (!(value instanceof Map)) throw mismatch();
      const out: Record<string, unknown> = {};
      for (const [k, v] of value) {
        Object.defineProperty(out, k, { value: observe(ty.of, v), enumerable: true });
      }
      return out;
    }
    case "presence": {
      const presence = value as Presence<unknown>;
      if (presence.state === "absent") return "absent";
      if (presence.state === "null") return "null";
      return { present: observe(ty.of, presence.value) };
    }
    case "optional":
      return value === undefined ? null : observe(ty.of, value);
    case "nullable":
      return value === null ? null : observe(ty.of, value);
  }
}

/**
 * An issue as a case writes one: the library's own JSON of it, with the message key under the
 * name the case format gives it. Nothing else is changed: what the library writes is the
 * observation the case compares.
 */
export function writeIssue(issue: Issue): unknown {
  const { path, code, messageKey, message, meta } = issueWire(issue);
  return { path, code, message_key: messageKey, message, meta };
}
