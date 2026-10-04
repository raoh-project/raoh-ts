// The values a decoder reads.
//
// The input model is what a JSON text denotes, with every number kept as it is written. A decoder
// reads it from plain JavaScript values: `null`, a boolean, a string, an array, an object (a
// plain object or a `Map` of string keys), and a number as a `JsonNumber`, which `parse` gives and
// which keeps the lexeme. A JavaScript `number` or `bigint` is read as the number it is, which is
// what an adapter that has already converted the text gives: `1.50` read by `JSON.parse` is 1.5,
// and a decimal decoder sees the scale 1. `undefined` is an absent value, at the top as much
// as an object's member.

import { Decimal } from "./decimal.ts";
import { ofThisCopy, tagOf } from "./copy.ts";

/** A number of the input model: the text it is written with. */
export class JsonNumber {
  readonly lexeme: string;

  constructor(lexeme: string) {
    if (!LEXEME.test(lexeme)) {
      throw new SyntaxError(`${JSON.stringify(lexeme)} is not a JSON number`);
    }
    this.lexeme = lexeme;
  }

  get [Symbol.toStringTag](): string {
    return tagOf("JsonNumber");
  }

  toString(): string {
    return this.lexeme;
  }

  /**
   * The number for `JSON.stringify` to write as this text. Where the engine has no
   * `JSON.rawJSON`, a JavaScript number is given in its place only where the text it is written
   * as denotes the same number; for one it would change, such as an integer beyond 2^53, this
   * throws rather than write another number.
   */
  toJSON(): unknown {
    const raw = (JSON as { rawJSON?: (text: string) => unknown }).rawJSON;
    if (raw !== undefined) {
      return raw(this.lexeme);
    }
    const number = Number(this.lexeme);
    if (!Number.isFinite(number) || Object.is(number, -0) || !sameNumber(String(number), this.lexeme)) {
      throw new RangeError(`${this.lexeme} cannot be written as a JavaScript number, and this engine has no JSON.rawJSON`);
    }
    return number;
  }
}

/** Whether the two JSON number texts denote the same number. */
function sameNumber(a: string, b: string): boolean {
  const x = Decimal.parse(a);
  const y = Decimal.parse(b);
  return x !== undefined && y !== undefined && x.compare(y) === 0;
}

const LEXEME = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/;

/** The kinds of value of the input model, and `missing` for no value at all. */
export type Kind = "null" | "boolean" | "number" | "string" | "array" | "object" | "missing";

/**
 * The kind of `value`, as an issue's `actual` names it.
 *
 * This is where a JavaScript value is read as a value of the input model, for a decoder and for
 * {@link stringify} alike. A string is one only where it is a sequence of Unicode scalar values;
 * an object is a `Map` of string keys, or an object whose data are its own properties, plain or an
 * instance of a class of the program's. A value that holds its data elsewhere — a `Date`, a `Set`,
 * a `String` or `Number` object, a typed array, a function — is no value of the input model, and
 * reading it as an object of no members, or of its characters, would read something it is not.
 *
 * @throws {TypeError} for a value that is no value of the input model
 */
export function kindOf(value: unknown): Kind {
  if (value === undefined) {
    return "missing";
  }
  if (value === null) {
    return "null";
  }
  switch (typeof value) {
    case "boolean":
      return "boolean";
    case "number":
    case "bigint":
      return "number";
    case "string":
      wellFormed(value);
      return "string";
    case "object":
      if (ofThisCopy(value, JsonNumber, "JsonNumber") || rawNumber(value) !== undefined) {
        return "number";
      }
      if (Array.isArray(value)) {
        return "array";
      }
      if (value instanceof Map || Object.prototype.toString.call(value) === "[object Object]") {
        return "object";
      }
      throw new TypeError(`${Object.prototype.toString.call(value)} is no value of the input model`);
    default:
      throw new TypeError(`a ${typeof value} is no value of the input model`);
  }
}

/** `text`, refused where it is not a sequence of Unicode scalar values, which no JSON text holds. */
function wellFormed(text: string): string {
  if (!text.isWellFormed()) {
    throw new TypeError(`${JSON.stringify(text)} holds an unpaired surrogate, and is no string of the input model`);
  }
  return text;
}

/**
 * The elements of an array of the input model, in order.
 *
 * @throws {TypeError} for an array with a hole, a place no value is at, which no JSON text writes
 */
export function elementsOf(value: readonly unknown[]): unknown[] {
  const out: unknown[] = [];
  for (let i = 0; i < value.length; i += 1) {
    if (!(i in value)) {
      throw new TypeError(`an array with no element at ${i} is no value of the input model`);
    }
    out.push(value[i]);
  }
  return out;
}

const isRawJSON = (JSON as { isRawJSON?: (value: unknown) => boolean }).isRawJSON;

/**
 * The text of a number `JSON.rawJSON` made, which is how JavaScript itself carries a number as it
 * is written; `undefined` for any other value.
 *
 * @throws {TypeError} for raw JSON that is not a number, which is no value of the input model
 */
function rawNumber(value: unknown): string | undefined {
  if (isRawJSON === undefined || !isRawJSON(value)) {
    return undefined;
  }
  const text = (value as { rawJSON: string }).rawJSON;
  if (!LEXEME.test(text)) {
    throw new TypeError(`raw JSON ${text} is not a number, and only a number is read from raw JSON`);
  }
  return text;
}

/** Whether `value` is an object of the input model. */
export function isObject(value: unknown): value is object {
  return kindOf(value) === "object";
}

/**
 * The lexeme of a number of the input model; `undefined` for a JavaScript number that no JSON
 * text writes (NaN or an infinity). An integer is written in full, as `BigInt` writes it, so that
 * 1e21 read by `JSON.parse` is still an integer to an integer decoder.
 */
export function lexemeOf(value: unknown): string | undefined {
  if (ofThisCopy(value, JsonNumber, "JsonNumber")) {
    return value.lexeme;
  }
  const raw = rawNumber(value);
  if (raw !== undefined) {
    return raw;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return undefined;
    }
    if (Object.is(value, -0)) {
      return "-0";
    }
    return Number.isInteger(value) ? BigInt(value).toString() : String(value);
  }
  return undefined;
}

/**
 * The members of an object of the input model, in order; a member whose value is `undefined` is
 * absent.
 *
 * @throws {TypeError} for a `Map` with a key that is not a string, and for a name that is not a
 *   sequence of Unicode scalar values: no JSON text names a member so
 */
export function membersOf(value: object): [string, unknown][] {
  const entries = value instanceof Map ? [...(value as Map<unknown, unknown>).entries()] : Object.entries(value);
  const out: [string, unknown][] = [];
  for (const [name, member] of entries) {
    if (typeof name !== "string") {
      throw new TypeError(`a Map with the key ${String(name)}, which is not a string, is no object of the input model`);
    }
    if (member !== undefined) {
      out.push([wellFormed(name), member]);
    }
  }
  return out;
}

/** The member of an object of the input model, or `undefined` where it is absent. */
export function memberOf(value: object, name: string): unknown {
  if (value instanceof Map) {
    return (value as Map<unknown, unknown>).get(name);
  }
  return Object.prototype.hasOwnProperty.call(value, name) ? (value as Record<string, unknown>)[name] : undefined;
}

/**
 * Reads a JSON text (RFC 8259) into the input model: every number a {@link JsonNumber} holding its
 * lexeme, and every object a `Map` holding its members in the order written.
 *
 * @throws {SyntaxError} where the text is not JSON, an object repeats a member name, or a string
 *   holds an unpaired surrogate, none of which is in the input model
 */
export function parse(text: string): unknown {
  const reader = new Reader(text);
  reader.space();
  const value = reader.value(0);
  reader.space();
  if (reader.at < text.length) {
    reader.fail("text after the value");
  }
  return value;
}

/**
 * Writes a value of the input model as JSON text, as {@link parse} reads it back: every number as
 * its lexeme, and every object's members in their order, a `Map`'s as it holds them. This is how
 * a value is handed on to what reads JSON text and not JavaScript values, such as a module across
 * a boundary, without a number rounded or a member moved: `JSON.stringify` writes a `Map` as `{}`
 * and an object's integer-like member names before its others.
 *
 * What it writes, `parse` reads, as the value it was: a value is read as {@link kindOf} reads one,
 * the same way a decoder reads it, so what the input model has no place for is refused here rather
 * than written as text `parse` refuses or as some other value.
 *
 * @throws {TypeError} for `undefined` where a value has to be, a hole in an array, a number that is
 *   NaN or an infinity, a string or member name holding an unpaired surrogate, and any value that
 *   is no value of the input model
 */
export function stringify(value: unknown): string {
  const out: string[] = [];
  write(value, out, 0);
  return out.join("");
}

function write(value: unknown, out: string[], depth: number): void {
  if (depth > DEPTH) {
    throw new TypeError(`nesting deeper than ${DEPTH}`);
  }
  switch (kindOf(value)) {
    case "missing":
      throw new TypeError("an absent value has no JSON text");
    case "null":
      out.push("null");
      return;
    case "boolean":
      out.push(value ? "true" : "false");
      return;
    case "string":
      out.push(JSON.stringify(value));
      return;
    case "number": {
      const lexeme = lexemeOf(value);
      if (lexeme === undefined) {
        throw new TypeError(`${String(value)} is in no JSON text`);
      }
      out.push(lexeme);
      return;
    }
    case "array": {
      out.push("[");
      elementsOf(value as unknown[]).forEach((item, i) => {
        if (i > 0) {
          out.push(",");
        }
        write(item, out, depth + 1);
      });
      out.push("]");
      return;
    }
    case "object": {
      out.push("{");
      membersOf(value as object).forEach(([name, member], i) => {
        if (i > 0) {
          out.push(",");
        }
        out.push(JSON.stringify(name), ":");
        write(member, out, depth + 1);
      });
      out.push("}");
    }
  }
}

/** How deep arrays and objects may nest before the text is refused rather than the stack overflowing. */
const DEPTH = 1000;

class Reader {
  readonly text: string;
  at = 0;

  constructor(text: string) {
    this.text = text;
  }

  fail(what: string): never {
    throw new SyntaxError(`not JSON: ${what} at ${this.at}`);
  }

  space(): void {
    while (this.at < this.text.length) {
      const c = this.text.charCodeAt(this.at);
      if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) {
        return;
      }
      this.at += 1;
    }
  }

  value(depth: number): unknown {
    if (depth > DEPTH) {
      this.fail(`nesting deeper than ${DEPTH}`);
    }
    const c = this.text[this.at];
    switch (c) {
      case "{":
        return this.object(depth);
      case "[":
        return this.array(depth);
      case '"':
        return this.string();
      case "t":
        return this.word("true", true);
      case "f":
        return this.word("false", false);
      case "n":
        return this.word("null", null);
      default:
        if (c === "-" || (c !== undefined && c >= "0" && c <= "9")) {
          return this.number();
        }
        return this.fail(c === undefined ? "the end of the text" : `${JSON.stringify(c)}`);
    }
  }

  word<T>(word: string, value: T): T {
    if (!this.text.startsWith(word, this.at)) {
      this.fail("an unknown word");
    }
    this.at += word.length;
    return value;
  }

  number(): JsonNumber {
    NUMBER_AT.lastIndex = this.at;
    const read = NUMBER_AT.exec(this.text);
    if (read === null) {
      this.fail("a malformed number");
    }
    this.at += read[0].length;
    return new JsonNumber(read[0]);
  }

  string(): string {
    this.at += 1;
    let out = "";
    let from = this.at;
    for (;;) {
      const c = this.text.charCodeAt(this.at);
      if (Number.isNaN(c)) {
        this.fail("an unterminated string");
      }
      if (c === 0x22) {
        out += this.text.slice(from, this.at);
        this.at += 1;
        break;
      }
      if (c < 0x20) {
        this.fail("a control character in a string");
      }
      if (c === 0x5c) {
        out += this.text.slice(from, this.at);
        out += this.escape();
        from = this.at;
        continue;
      }
      this.at += 1;
    }
    if (!out.isWellFormed()) {
      this.fail("a string holding an unpaired surrogate");
    }
    return out;
  }

  escape(): string {
    const c = this.text[this.at + 1];
    this.at += 2;
    switch (c) {
      case '"':
        return '"';
      case "\\":
        return "\\";
      case "/":
        return "/";
      case "b":
        return "\b";
      case "f":
        return "\f";
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      case "u": {
        const hex = this.text.slice(this.at, this.at + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
          this.fail("a malformed \\u escape");
        }
        this.at += 4;
        return String.fromCharCode(Number.parseInt(hex, 16));
      }
      default:
        return this.fail("an unknown escape");
    }
  }

  array(depth: number): unknown[] {
    this.at += 1;
    const out: unknown[] = [];
    this.space();
    if (this.text[this.at] === "]") {
      this.at += 1;
      return out;
    }
    for (;;) {
      this.space();
      out.push(this.value(depth + 1));
      this.space();
      const c = this.text[this.at];
      this.at += 1;
      if (c === "]") {
        return out;
      }
      if (c !== ",") {
        this.at -= 1;
        this.fail("an array not closed");
      }
    }
  }

  object(depth: number): Map<string, unknown> {
    this.at += 1;
    const out = new Map<string, unknown>();
    this.space();
    if (this.text[this.at] === "}") {
      this.at += 1;
      return out;
    }
    for (;;) {
      this.space();
      if (this.text[this.at] !== '"') {
        this.fail("a member without a name");
      }
      const name = this.string();
      if (out.has(name)) {
        this.fail(`the member ${JSON.stringify(name)} twice`);
      }
      this.space();
      if (this.text[this.at] !== ":") {
        this.fail("a member name without a colon");
      }
      this.at += 1;
      this.space();
      out.set(name, this.value(depth + 1));
      this.space();
      const c = this.text[this.at];
      this.at += 1;
      if (c === "}") {
        return out;
      }
      if (c !== ",") {
        this.at -= 1;
        this.fail("an object not closed");
      }
    }
  }
}

const NUMBER_AT = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
