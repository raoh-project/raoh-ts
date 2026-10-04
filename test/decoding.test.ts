// What the conformance suite does not reach: the values a TypeScript caller hands over, the types
// a decoder gives, and the API a caller writes against.

import assert from "node:assert/strict";
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import {
  Decimal,
  Issue,
  Messages,
  Path,
  ValueSet,
  decimal,
  dict,
  discriminate,
  double,
  enumOf,
  float,
  issueWire,
  oneOf,
  failed,
  field,
  int,
  list,
  literal,
  long,
  object,
  ok,
  optionalField,
  parse,
  string,
  stringify,
} from "../src/index.ts";

const CATALOG_JA_TEXT = "raoh.required=必須です";

test("reads what JSON.parse gives as it reads what parse gives, short of what JSON.parse loses", () => {
  const point = object(field("x", int()), field("y", long()), field("price", decimal()));
  const given = point.decode(JSON.parse('{"x": 1, "y": 9007199254740993, "price": 1.50}'));
  const kept = point.decode(parse('{"x": 1, "y": 9007199254740993, "price": 1.50}'));

  assert.deepEqual(given.value?.[0], 1);
  // JSON.parse has rounded the integer and dropped the trailing zero before a decoder sees them.
  assert.equal(given.value?.[1], 9007199254740992n);
  assert.equal(String(given.value?.[2]), "1.5");
  assert.equal(kept.value?.[1], 9007199254740993n);
  assert.equal(String(kept.value?.[2]), "1.50");
});

test("reads an object handed over as a Map, a plain object or an instance alike, an undefined member as absent", () => {
  const named = object(field("name", string()), optionalField("nick", string()));

  assert.deepEqual(named.decode(new Map([["name", "a"]])).value, ["a", undefined]);
  assert.deepEqual(named.decode({ name: "a", nick: undefined }).value, ["a", undefined]);
  class Form {
    name = "a";
    nick = "b";
  }
  assert.deepEqual(named.decode(new Form()).value, ["a", "b"]);
});

test("says why text that is not JSON was not read, in the reader's language", () => {
  const read = int().decodeJson("{");

  const [issue] = read.issues ?? [];
  assert.equal(issue?.messageKey, "invalid_format.json");
  assert.equal(issue?.message(), "not valid JSON");
  assert.equal(issue?.message(Messages.japanese), "JSONとして読めません");
});

test("gives a sum of products as a union the caller narrows by its tag", () => {
  const shape = discriminate("type", {
    circle: object(field("type", literal("circle")), field("radius", double().positive())),
    square: object(field("type", literal("square")), field("side", int().positive())),
  });

  const read = shape.decode({ type: "square", side: 3 });
  assert.ok(read.issues === undefined);
  const [tag] = read.value;
  assert.equal(tag, "square");
  assert.deepEqual(
    shape.decode({ type: "triangle" }).issues?.list.map((i) => [i.path.toString(), i.code, i.meta]),
    [["/type", "not_allowed", { allowed: ["circle", "square"] }]],
  );
});

test("gives an enumeration's symbol as it is declared, whatever case of ASCII it was written in", () => {
  const color = enumOf(["Red", "GREEN"]);

  assert.equal(color.decode("red").value, "Red");
  assert.equal(color.decode("green").value, "GREEN");
  assert.deepEqual(color.decode("blue").issues?.list[0]?.meta, { allowed: ["green", "red"] });
  assert.throws(() => enumOf(["a", "A"]), RangeError);
});

test("relates the parts of a value once they exist, the rule's issues below the decoder's path", () => {
  const period = object(field("start", int()), field("end", int())).flatMap(([start, end]) =>
    start <= end ? ok({ start, end }) : failed(new Issue("invalid_value", { message: "end is before start", path: ["end"] })),
  );
  const trip = object(field("period", period));

  const [issue] = trip.decode({ period: { start: 5, end: 1 } }).issues ?? [];
  assert.equal(issue?.path.toString(), "/period/end");
  assert.equal(issue?.message(Messages.japanese), "end is before start");
});

test("writes a float bound in a message as the float it is, and a decimal at its scale", () => {
  const [low] = double().min(0.5).decode(0.25).issues ?? [];
  const [cheap] = decimal().min(Decimal.parse("1.50") as Decimal).decode(parse("1.2")).issues ?? [];

  assert.equal(low?.message(), "must be at least 0.5");
  assert.equal(cheap?.message(), "must be at least 1.50");
});

test("keeps +0 and -0 apart in a set, and one NaN", () => {
  const read = list(double()).toSet().decode(parse("[0, -0.0, 0.0, 1]"));

  assert.ok(read.value instanceof ValueSet);
  assert.equal(read.value.size, 3);
  assert.ok(read.value.has(-0));
  assert.ok(ValueSet.of([NaN, NaN]).size === 1);
});

test("escapes a path's segments once, and reads back exactly the path it wrote", () => {
  const path = Path.of("a/b", "~c", 2);

  assert.equal(path.toString(), "/a~1b/~0c/2");
  assert.equal(Path.ROOT.toString(), "");
  // A pointer does not say whether a token is a member's name or an index, so neither does a path.
  assert.ok(Path.of("0").equals(Path.of(0)));
  for (const pointer of ["", "/a~1b/~0c/2", "/0", "/9007199254740993", "/007", "/-1", "/"]) {
    assert.equal(Path.parse(pointer).toString(), pointer);
    assert.ok(Path.parse(Path.parse(pointer).toString()).equals(Path.parse(pointer)));
  }
  assert.throws(() => Path.ROOT.child(-1), RangeError);
  assert.throws(() => Path.ROOT.child(2 ** 53), RangeError);
});

test("writes an issue as JSON whatever its metadata holds, every number as the number it is", () => {
  const [long_] = long().min(10n).decode(1n).issues ?? [];
  const [big] = long().max(9007199254740992n).decode(parse("9007199254740993")).issues ?? [];
  const [negativeZero] = double().positive().decode(parse("-0.0")).issues ?? [];
  const [float32] = float().min(0.1).decode(0).issues ?? [];
  const [scaled] = decimal().min(Decimal.parse("1.50") as Decimal).decode(parse("1.2")).issues ?? [];
  const tried = oneOf(string(), long().min(5n)).decode(1n).issues;

  assert.equal(
    JSON.stringify(long_),
    '{"path":"","code":"out_of_range","messageKey":"out_of_range.minimum","message":"must be at least 10","meta":{"min":10,"actual":1}}',
  );
  assert.match(JSON.stringify(big), /"meta":\{"max":9007199254740992,"actual":9007199254740993\}/);
  assert.match(JSON.stringify(negativeZero), /"actual":\{"float":"-0"\}/);
  assert.match(JSON.stringify(float32), /"min":0\.1,/);
  assert.match(JSON.stringify(scaled), /"min":"1\.50"/);
  // The issues a one_of_failed lists are written as the specification observes the issues type:
  // with no message key, which only the issue that holds them carries.
  assert.deepEqual(JSON.parse(JSON.stringify(tried)), [
    {
      path: "",
      code: "one_of_failed",
      messageKey: "one_of_failed",
      message: "no variant matched",
      meta: {
        candidates: [
          {
            candidate: 0,
            issues: [{ path: "", code: "type_mismatch", message: "expected string", meta: { expected: "string", actual: "number" } }],
          },
          {
            candidate: 1,
            issues: [{ path: "", code: "out_of_range", message: "must be at least 5", meta: { min: 5, actual: 1 } }],
          },
        ],
      },
    },
  ]);
  // A number of the input model is written as it was read.
  assert.equal(JSON.stringify(parse("[9007199254740993, 1.50, -0]")), "[9007199254740993,1.50,-0]");
});

test("on an engine without JSON.rawJSON, writes a number as a JavaScript number only where that keeps it", () => {
  const json = JSON as { rawJSON?: unknown };
  const raw = json.rawJSON;
  delete json.rawJSON;
  try {
    assert.equal(JSON.stringify(parse("[1, 0.1, 1.0E7, 1.50]")), "[1,0.1,10000000,1.5]");
    assert.throws(() => JSON.stringify(parse("9007199254740993")), RangeError);
    assert.throws(() => JSON.stringify(parse("-0")), RangeError);
  } finally {
    json.rawJSON = raw;
  }
});

test("writes an issue's sentence in the catalogue asked for", () => {
  const read = string().minLength(3).decode("ab");

  assert.equal(read.issues?.toWire(Messages.japanese)[0]?.message, "3文字以上で入力してください");
  assert.equal(issueWire(read.issues?.list[0] as Issue, Messages.japanese).message, "3文字以上で入力してください");
});

test("reads a catalogue of one's own, falling back to another", () => {
  const french = Messages.fromProperties("raoh.invalid_format=format invalide\nraoh.too_short=au moins {min} \\u00e9l\\u00e9ments").fallingBackTo(
    Messages.english,
  );

  const [short] = string().minLength(3).decode("ab").issues ?? [];
  const [email] = string().email().decode("x").issues ?? [];
  const [required] = string().decode(null).issues ?? [];
  assert.equal(short?.message(french), "au moins 3 éléments");
  assert.equal(email?.message(french), "format invalide");
  assert.equal(required?.message(french), "is required");
});

test("writes a value of the input model as the JSON text parse reads it back from", () => {
  const text = '{"b":1.50,"1":[9007199254740993,-0,true,null,"é"],"a":{}}';

  assert.equal(stringify(parse(text)), text);
  // A plain object's members as it holds them, an absent member left out, numbers as they are.
  assert.equal(stringify({ x: 1, y: undefined, z: [2n, -0] }), '{"x":1,"z":[2,-0]}');
  assert.throws(() => stringify(undefined), TypeError);
  assert.throws(() => stringify([NaN]), TypeError);
});

test("reads a number JSON.rawJSON made as the number it is written as", () => {
  const raw = (JSON as unknown as { rawJSON(text: string): unknown }).rawJSON;

  assert.equal(String(decimal().decode(raw("1.50")).value), "1.50");
  assert.equal(long().decode(raw("9007199254740993")).value, 9007199254740993n);
  assert.equal(stringify([raw("1.50")]), "[1.50]");
  assert.throws(() => string().decode(raw('"text"')), TypeError);
  // And written as that number where an issue holds it, by the same rule that read it.
  const held = new Issue("missing_element", { meta: { expected: raw("12345678901234567890.5") } });
  assert.equal(JSON.stringify(held.toJSON().meta), '{"expected":12345678901234567890.5}');
});

test("writes what a fallback says of an issue no catalogue has a template for, in every language over it", () => {
  const own = (issue: Issue) => `broken: ${String(issue.meta.rule)}`;
  const english = Messages.english.withFallback(own);
  const japanese = Messages.fromProperties(CATALOG_JA_TEXT).fallingBackTo(english);
  const ruled = new Issue("invariant_violation", { meta: { rule: "even" } });

  assert.equal(ruled.message(english), "broken: even");
  assert.equal(ruled.message(japanese), "broken: even");
  assert.equal(ruled.message(Messages.english), "validation failed: invariant_violation");
  // A template, where a catalogue has one, wins over the fallback.
  assert.equal(new Issue("required").message(japanese), "必須です");
  assert.equal(ruled.message(english.withOverrides({ invariant_violation: "rule {rule}" })), "rule even");
});

test("refuses a value another copy of the library made, where it would otherwise be misread", async () => {
  // The sources copied somewhere else are another copy, as one a library brings with it would be.
  const elsewhere = mkdtempSync(join(tmpdir(), "raoh-copy-"));
  cpSync(join(import.meta.dirname, "..", "src"), elsewhere, { recursive: true });
  const other = (await import(pathToFileURL(join(elsewhere, "index.ts")).href)) as typeof import("../src/index.ts");
  const theirs = other.parse("[1.50]") as unknown[];

  assert.throws(() => stringify(theirs), /another copy of @raoh\/core/);
  assert.throws(() => decimal().decode(theirs[0]), /another copy of @raoh\/core/);
  assert.throws(() => new Issue("required").under(other.Path.of("a")), /another copy of @raoh\/core/);
  assert.throws(() => new Issue("required", { path: other.Path.of("a") }), /another copy of @raoh\/core/);
  assert.throws(() => JSON.stringify(new Issue("x", { meta: { bound: other.Decimal.of(1) } })), /another copy/);
  assert.throws(() => failed(new other.Issue("required")), /another copy of @raoh\/core/);
  // A copy's own values are its own.
  assert.equal(other.stringify(theirs), "[1.50]");
});

test("writes only what parse reads back, as the value it was, and refuses what the input model has no place for", () => {
  const sparse: unknown[] = [];
  sparse[1] = 1;
  const refused: [string, unknown][] = [
    ["a hole in an array", sparse],
    ["an unpaired surrogate", "\ud800"],
    ["a member name with an unpaired surrogate", { "\udc00": 1 }],
    ["a Map key that is not a string", new Map<unknown, unknown>([[1, "x"]])],
    ["a String object", new String("ab")],
    ["a Date", new Date(0)],
    ["a Set", new Set([1])],
    ["a function", () => 1],
    ["NaN", Number.NaN],
  ];
  for (const [what, value] of refused) {
    assert.throws(() => stringify(value), TypeError, what);
  }
  // A decoder reads a value by the same rule, so what stringify refuses no decoder reads either.
  assert.throws(() => list(int()).decode(sparse), TypeError);
  assert.throws(() => string().decode("\ud800"), TypeError);
  assert.throws(() => dict(int()).decode(new Map<unknown, unknown>([[1, 1]])), TypeError);

  class Form {
    name = "a";
    lines = [1, 2.5];
  }
  const written: unknown[] = [
    null, true, "é😀", "", -0, 1e-7, 1e21, 2n ** 70n, [], {}, [[[]]], new Map<string, unknown>([["1", 1], ["a", [null]]]),
    { b: { c: "\u0000\n\"" }, a: undefined }, new Form(), parse('{"x":1.50,"y":[-0.0,1E+3]}'),
  ];
  for (const value of written) {
    const text = stringify(value);
    assert.equal(stringify(parse(text)), text, text);
  }
});
