// Translates the forms of a case (spec/decoder-language.md) into Raoh's decoders and encoders.

import {
  BoolDecoder,
  BoundedDecoder,
  DecimalDecoder,
  type Decoder,
  DictDecoder,
  DoubleDecoder,
  type Field,
  FloatDecoder,
  IntDecoder,
  ListDecoder,
  LongDecoder,
  StringDecoder,
  bool,
  decimal,
  dict,
  discriminate,
  discriminateBy,
  double,
  encode,
  enumOf,
  field,
  flat,
  float,
  int,
  list,
  literal,
  long,
  object,
  oneOf,
  optionalField,
  optionalNullableField,
  strict,
  string,
} from "../src/index.ts";
import { even, issueCountPlus10, mapFixture, notEven, orderedPeriod } from "./fixtures.ts";
import { T, type Ty, Unbound, read } from "./value.ts";

/** An argument of a form, as catalog/operations.json declares it. */
interface ArgDef {
  readonly kind: string;
  readonly optional: boolean;
}

/** What the runner reads from catalog/operations.json: the arguments of each form. */
export class Catalog {
  readonly constructors = new Map<string, ArgDef[]>();
  readonly operations = new Map<string, ArgDef[]>();

  constructor(operations: {
    constructors: Record<string, { args?: { kind: string; optional?: boolean }[] }>;
    operations: { name: string; args?: { kind: string; optional?: boolean }[] }[];
  }) {
    const defs = (args: { kind: string; optional?: boolean }[] | undefined): ArgDef[] =>
      (args ?? []).map((a) => ({ kind: a.kind, optional: a.optional ?? false }));
    for (const [name, c] of Object.entries(operations.constructors)) {
      this.constructors.set(name, defs(c.args));
    }
    for (const o of operations.operations) {
      if (!this.operations.has(o.name)) {
        this.operations.set(o.name, defs(o.args));
      }
    }
  }
}

/** A decoder a form builds, and its result type. */
interface Built {
  readonly decoder: Decoder<unknown>;
  readonly ty: Ty;
}

function form(value: unknown): unknown[] {
  if (!Array.isArray(value) || typeof value[0] !== "string") {
    throw new Error(`${String(value)} is not a form`);
  }
  return value;
}

function text(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error(`${String(value)} is not a string`);
  }
  return value;
}

/** The kind of a receiver, as an operation's feature names it. */
function kindOf(ty: Ty): string {
  return ty.kind;
}

/** Builds the decoders and encoders of one case, recording every feature they use. */
export class Binder {
  readonly used = new Set<string>();
  readonly #catalog: Catalog;

  constructor(catalog: Catalog) {
    this.#catalog = catalog;
  }

  /** The decoder `value` names, and its result type. */
  decoder(value: unknown): Built {
    const f = form(value);
    const name = f[0] as string;
    this.used.add(`decoder.${name}`);
    const defs = this.#catalog.constructors.get(name);
    if (defs === undefined) {
      throw new Error(`no constructor ${name}`);
    }
    const required = defs.filter((d) => !d.optional).length;
    if (f.length < 1 + required) {
      throw new Error(`${name} takes ${required} arguments`);
    }
    const args = f.slice(1, 1 + required);
    let rest = f.slice(1 + required);
    let message: string | undefined;
    if (defs.some((d) => d.kind === "message") && typeof rest[0] === "string") {
      this.used.add(`decoder.${name}.message`);
      message = rest[0];
      rest = rest.slice(1);
    }
    let built = this.#construct(name, args, message);
    for (const operation of rest) {
      built = this.#operation(built, operation);
    }
    return built;
  }

  #stringDecoder(value: unknown): Decoder<string> {
    const built = this.decoder(value);
    if (built.ty.kind !== "string") {
      throw new Error(`${JSON.stringify(built.ty)} is not a string decoder`);
    }
    return built.decoder as Decoder<string>;
  }

  #construct(name: string, args: unknown[], message: string | undefined): Built {
    switch (name) {
      case "string":
        return { decoder: string(), ty: T.string };
      case "int":
        return { decoder: int(), ty: T.int32 };
      case "long":
        return { decoder: long(), ty: T.int64 };
      case "float":
        return { decoder: float(), ty: T.float32 };
      case "double":
        return { decoder: double(), ty: T.float64 };
      case "decimal":
        return { decoder: decimal(), ty: T.decimal };
      case "bool":
        return { decoder: bool(), ty: T.bool };
      case "list": {
        const element = this.decoder(args[0]);
        return { decoder: list(element.decoder), ty: T.list(element.ty) };
      }
      case "dict": {
        const value = this.decoder(args[0]);
        return { decoder: dict(value.decoder), ty: T.map(value.ty) };
      }
      case "object":
      case "strictObject": {
        const [fields, tys] = this.#fields(args[0]);
        const decoder = object(...fields);
        return { decoder: name === "object" ? decoder : decoder.strict(), ty: T.product(tys) };
      }
      case "strict": {
        const inner = this.decoder(args[0]);
        return { decoder: strict(inner.decoder, read(T.list(T.string), args[1]) as string[]), ty: inner.ty };
      }
      case "nullable": {
        const inner = this.decoder(args[0]);
        return { decoder: inner.decoder.nullable(), ty: T.nullable(inner.ty) };
      }
      case "enum": {
        const symbols = (args[0] as unknown[]).map(text);
        return { decoder: enumOf(symbols, { string: this.#stringDecoder(args[1]), message }), ty: T.symbol(symbols) };
      }
      case "literal":
        return { decoder: literal(text(args[0]), { string: this.#stringDecoder(args[1]), message }), ty: T.string };
      case "discriminate": {
        const [variants, ty] = this.#variants(args[1]);
        return { decoder: discriminate(text(args[0]), variants), ty };
      }
      case "discriminateBy": {
        const tag = this.decoder(args[1]);
        if (tag.ty.kind !== "string") {
          throw new Error(`the tag decoder gives ${JSON.stringify(tag.ty)}, not a string`);
        }
        const [variants, ty] = this.#variants(args[2]);
        return { decoder: discriminateBy(text(args[0]), tag.decoder as Decoder<string>, variants), ty };
      }
      case "oneOf": {
        const candidates = (args[0] as unknown[]).map((c) => this.decoder(c));
        const first = candidates[0];
        if (first === undefined) {
          throw new Error("oneOf takes at least one decoder");
        }
        return { decoder: oneOf(...candidates.map((c) => c.decoder)), ty: first.ty };
      }
      case "withDefault": {
        const inner = this.decoder(args[0]);
        return { decoder: inner.decoder.withDefault(read(inner.ty, args[1])), ty: inner.ty };
      }
      case "recover": {
        const inner = this.decoder(args[0]);
        return { decoder: inner.decoder.recover(read(inner.ty, args[1])), ty: inner.ty };
      }
      case "recoverWith": {
        const inner = this.decoder(args[0]);
        const fixture = text(args[1]);
        this.used.add(`fixture.${fixture}`);
        if (fixture !== "issue_count_plus_10") {
          throw new Error(`no recover fixture ${fixture}`);
        }
        return { decoder: inner.decoder.recoverWith(issueCountPlus10), ty: inner.ty };
      }
      default:
        throw new Error(`no constructor ${name}`);
    }
  }

  #fields(value: unknown): [Field<unknown>[], Ty[]] {
    const fields: Field<unknown>[] = [];
    const tys: Ty[] = [];
    for (const each of value as unknown[]) {
      const f = form(each);
      const kind = f[0] as string;
      this.used.add(`field.${kind}`);
      if (kind === "flat") {
        const inner = this.decoder(f[1]);
        fields.push(flat(inner.decoder));
        tys.push(inner.ty);
        continue;
      }
      const name = text(f[1]);
      const inner = this.decoder(f[2]);
      switch (kind) {
        case "field":
          fields.push(field(name, inner.decoder));
          tys.push(inner.ty);
          break;
        case "optionalField":
          fields.push(optionalField(name, inner.decoder));
          tys.push(T.optional(inner.ty));
          break;
        case "optionalNullableField":
          fields.push(optionalNullableField(name, inner.decoder));
          tys.push(T.presence(inner.ty));
          break;
        default:
          throw new Error(`no field kind ${kind}`);
      }
    }
    return [fields, tys];
  }

  #variants(value: unknown): [Record<string, Decoder<unknown>>, Ty] {
    if (!(value instanceof Map)) {
      throw new Error("variants are an object");
    }
    const variants: Record<string, Decoder<unknown>> = {};
    let ty: Ty | undefined;
    for (const [tag, each] of value as Map<string, unknown>) {
      const built = this.decoder(each);
      ty ??= built.ty;
      Object.defineProperty(variants, tag, { value: built.decoder, enumerable: true });
    }
    if (ty === undefined) {
      throw new Error("there is no variant");
    }
    return [variants, ty];
  }

  /** Splits an operation's arguments into its value arguments and its message. */
  #split(name: string, given: unknown[]): [unknown[], string | undefined] {
    const defs = this.#catalog.operations.get(name);
    if (defs === undefined) {
      throw new Error(`no operation ${name}`);
    }
    const values: unknown[] = [];
    let message: string | undefined;
    let at = 0;
    for (const def of defs) {
      const next = given[at];
      if (def.kind === "message") {
        if (typeof next === "string") {
          message = next;
          at += 1;
        }
      } else if (at < given.length) {
        values.push(next);
        at += 1;
      } else if (!def.optional) {
        throw new Error(`${name} is missing an argument`);
      }
    }
    if (at < given.length) {
      throw new Error(`${name} has too many arguments`);
    }
    return [values, message];
  }

  #operation(built: Built, value: unknown): Built {
    const f = form(value);
    const name = f[0] as string;
    const generic = name === "map" || name === "refine" || name === "flatMap";
    const kind = generic ? "any" : kindOf(built.ty);
    this.used.add(`operation.${kind}.${name}`);
    const [values, message] = this.#split(name, f.slice(1));
    if (message !== undefined) {
      this.used.add(`operation.${kind}.${name}.message`);
    }
    return generic ? this.#generic(built, name, text(values[0])) : typed(built, name, values, message);
  }

  #generic(built: Built, name: string, fixture: string): Built {
    this.used.add(`fixture.${fixture}`);
    if (name === "map") {
      const [ty, f] = mapFixture(fixture, built.ty);
      return { decoder: built.decoder.map(f), ty };
    }
    if (name === "refine" && fixture === "even") {
      return { decoder: built.decoder.refine(even, notEven), ty: built.ty };
    }
    if (name === "flatMap" && fixture === "ordered_period") {
      return { decoder: built.decoder.flatMap(orderedPeriod), ty: built.ty };
    }
    throw new Error(`no ${name} fixture ${fixture}`);
  }

  /** The JSON the encoder `value` names writes for the value `input` observes. */
  encode(value: unknown, input: unknown): unknown {
    const f = form(value);
    const name = f[0] as string;
    this.used.add(`encoder.${name}`);
    if (name === "string") {
      return encode.string().encode(read(T.string, input) as string);
    }
    if (name !== "object") {
      throw new Error(`no encoder ${name}`);
    }
    const properties: encode.Property<unknown>[] = [];
    for (const each of f[1] as unknown[]) {
      const property = form(each);
      const kind = property[0] as string;
      this.used.add(`property.${kind}`);
      if (kind !== "propertyWithDefault") {
        throw new Error(`no property ${kind}`);
      }
      const getter = text(property[2]);
      this.used.add(`fixture.${getter}`);
      if (getter !== "identity") {
        throw new Error(`no getter fixture ${getter}`);
      }
      const inner = form(property[3]);
      this.used.add(`encoder.${inner[0] as string}`);
      if (inner[0] !== "string") {
        throw new Error(`no encoder ${String(inner[0])} in a property`);
      }
      properties.push(
        encode.propertyWithDefault(text(property[1]), (v: unknown) => v as string | null, encode.string(), read(T.string, property[4]) as string),
      );
    }
    // identity reads the value being encoded, a nullable<string>, as the property's value.
    return encode.object(...properties).encode(read(T.nullable(T.string), input));
  }
}

/** An operation on a decoder of a scalar, a list or a map. */
function typed(built: Built, name: string, args: unknown[], message: string | undefined): Built {
  const { decoder, ty } = built;
  const arg = (i: number, t: Ty) => read(t, args[i]);
  const no = () => new Error(`no operation ${name} on ${JSON.stringify(ty)}`);
  if (decoder instanceof StringDecoder) {
    return stringOperation(decoder, name, arg, message, no);
  }
  if (decoder instanceof BoundedDecoder) {
    return { decoder: bounded(decoder, ty, name, arg, message, no), ty };
  }
  if (decoder instanceof BoolDecoder) {
    if (name !== "isTrue") throw no();
    return { decoder: decoder.isTrue(message), ty };
  }
  if (decoder instanceof ListDecoder && ty.kind === "list") {
    const element = ty.of;
    const list = decoder as ListDecoder<unknown>;
    switch (name) {
      case "nonempty":
        return { decoder: list.nonempty(message), ty };
      case "minSize":
        return { decoder: list.minSize(arg(0, T.int32) as number, message), ty };
      case "maxSize":
        return { decoder: list.maxSize(arg(0, T.int32) as number, message), ty };
      case "fixedSize":
        return { decoder: list.fixedSize(arg(0, T.int32) as number, message), ty };
      case "unique":
        return { decoder: list.unique(message), ty };
      case "contains":
        return { decoder: list.contains(arg(0, element), message), ty };
      case "containsAll":
        return { decoder: list.containsAll(arg(0, T.list(element)) as unknown[], message), ty };
      case "toSet":
        return { decoder: list.toSet(), ty: T.set(element) };
      default:
        throw no();
    }
  }
  if (decoder instanceof DictDecoder) {
    const map = decoder as DictDecoder<unknown>;
    switch (name) {
      case "nonempty":
        return { decoder: map.nonempty(message), ty };
      case "minSize":
        return { decoder: map.minSize(arg(0, T.int32) as number, message), ty };
      case "maxSize":
        return { decoder: map.maxSize(arg(0, T.int32) as number, message), ty };
      case "fixedSize":
        return { decoder: map.fixedSize(arg(0, T.int32) as number, message), ty };
      default:
        throw no();
    }
  }
  throw no();
}

/** The operations of strings that need the text rules of 199x-notation, which raoh-ts does not bind yet. */
const NOTATION = new Set([
  "trim",
  "toLowerCase",
  "toUpperCase",
  "normalize",
  "nonBlank",
  "pattern",
  "iso8601",
  "date",
  "time",
  "dateTime",
  "offsetDateTime",
]);

function stringOperation(
  d: StringDecoder,
  name: string,
  arg: (i: number, t: Ty) => unknown,
  message: string | undefined,
  no: () => Error,
): Built {
  const s = (decoder: Decoder<unknown>) => ({ decoder, ty: T.string });
  if (NOTATION.has(name)) {
    throw new Unbound(`operation.string.${name}`);
  }
  switch (name) {
    case "minLength":
      return s(d.minLength(arg(0, T.int32) as number, message));
    case "maxLength":
      return s(d.maxLength(arg(0, T.int32) as number, message));
    case "fixedLength":
      return s(d.fixedLength(arg(0, T.int32) as number, message));
    case "oneOf":
      return s(d.oneOf(arg(0, T.list(T.string)) as string[], message));
    case "startsWith":
      return s(d.startsWith(arg(0, T.string) as string, message));
    case "endsWith":
      return s(d.endsWith(arg(0, T.string) as string, message));
    case "includes":
      return s(d.includes(arg(0, T.string) as string, message));
    case "email":
      return s(d.email(message));
    case "ipv4":
      return s(d.ipv4(message));
    case "ipv6":
      return s(d.ipv6(message));
    case "ip":
      return s(d.ip(message));
    case "ulid":
      return s(d.ulid(message));
    case "cuid":
      return s(d.cuid(message));
    case "uuid":
      return { decoder: d.uuid(message), ty: T.uuid };
    case "url":
      return { decoder: d.url(message), ty: T.uri };
    case "uri":
      return { decoder: d.uri(message), ty: T.uri };
    case "toInt":
      return { decoder: d.toInt(message), ty: T.int32 };
    case "toLong":
      return { decoder: d.toLong(message), ty: T.int64 };
    case "toDecimal":
      return { decoder: d.toDecimal(message), ty: T.decimal };
    case "toBool":
      return { decoder: d.toBool(message), ty: T.bool };
    default:
      throw no();
  }
}

function bounded(
  d: BoundedDecoder<unknown>,
  ty: Ty,
  name: string,
  arg: (i: number, t: Ty) => unknown,
  message: string | undefined,
  no: () => Error,
): Decoder<unknown> {
  switch (name) {
    case "min":
      return d.min(arg(0, ty), message);
    case "max":
      return d.max(arg(0, ty), message);
    case "range":
      return d.range(arg(0, ty), arg(1, ty), message);
    case "positive":
      return d.positive(message);
    case "negative":
      return d.negative(message);
    case "nonNegative":
      return d.nonNegative(message);
    case "nonPositive":
      return d.nonPositive(message);
  }
  if (name === "oneOf") {
    const allowed = arg(0, T.list(ty)) as never[];
    if (d instanceof IntDecoder || d instanceof LongDecoder || d instanceof FloatDecoder || d instanceof DoubleDecoder) {
      return d.oneOf(allowed, message);
    }
  }
  if (name === "multipleOf") {
    const divisor = arg(0, ty) as never;
    if (d instanceof IntDecoder || d instanceof LongDecoder || d instanceof DecimalDecoder) {
      return d.multipleOf(divisor, message);
    }
  }
  if (name === "scale" && d instanceof DecimalDecoder) {
    return d.scale(arg(0, T.int32) as number, message);
  }
  throw no();
}
