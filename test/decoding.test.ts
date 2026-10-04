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

test("escapes a path's segments once, and reads one back", () => {
  const path = Path.of("a/b", "~c", 2);

  assert.equal(path.toString(), "/a~1b/~0c/2");
  assert.ok(Path.parse(path.toString()).equals(path));
  assert.equal(Path.ROOT.toString(), "");
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
