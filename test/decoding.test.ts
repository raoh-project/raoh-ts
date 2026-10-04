// What the conformance suite does not reach: the values a TypeScript caller hands over, the types
// a decoder gives, and the API a caller writes against.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Decimal,
  Issue,
  Messages,
  Path,
  ValueSet,
  decimal,
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
} from "../src/index.ts";

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
