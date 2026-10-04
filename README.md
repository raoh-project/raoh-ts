# raoh-ts

TypeScript implementation of [Raoh](https://github.com/raoh-project/raoh-specification), a decoder
library for turning untyped boundary input into typed domain values. It is published to npm as
`@raoh/core`.

It is built around a parse-don't-validate approach:

- decode at the boundary
- keep invalid states out of the domain model
- return failures as values instead of throwing
- attach structured errors to precise paths

When the input is wrong, a decoder reports every problem it found, each with the JSON Pointer of
where it was, instead of stopping at the first one.

## Installation

```sh
npm install @raoh/core
```

It is an ES module with no dependencies, and runs on Node 22 and later and in current browsers.

## Quick start

```ts
import { field, int, object, string } from "@raoh/core";

class User {
  constructor(readonly email: string, readonly age: number) {}
}

const user = object(
  field("email", string().email()),
  field("age", int().range(0, 150)),
).map(([email, age]) => new User(email, age));

const read = user.decode({ email: "not an email", age: 200 });
if (read.issues !== undefined) {
  console.log(JSON.stringify(read.issues));
  // [{"path":"/email","code":"invalid_format","messageKey":"invalid_format.email",
  //   "message":"not a valid email","meta":{}},
  //  {"path":"/age","code":"out_of_range","messageKey":"out_of_range.range",
  //   "message":"must be between 0 and 150","meta":{"min":0,"max":150,"actual":200}}]
} else {
  read.value; // a User
}
```

## The model

### `Decoder<T>`

A decoder is a value that describes how to read an input. What it gives depends on the input
alone, so it can be kept in a module-level constant and shared.

```ts
abstract class Decoder<T> {
  decode(input: unknown): Result<T>;
  decodeJson(text: string): Result<T>;
  decodeAt(input: unknown, path: Path): Result<T>;
  map, flatMap, refine, nullable, withDefault, recover, recoverWith
}
```

`Result<T>` is `{ value: T }` or `{ issues: Issues }`; checking `issues` narrows it.

The operations of each kind of value are methods of its decoder and give a decoder of the same
kind, so they chain: `string().minLength(3).maxLength(20)`, `int().positive()`,
`list(string()).nonempty().unique()`. Each operation that checks something takes an optional last
argument, a sentence to give in place of the catalogue's.

### `Issue` and `Issues`

Each issue has a `path` (a `Path`, written as a JSON Pointer), a `code` such as `out_of_range`, a
`messageKey` such as `out_of_range.minimum`, and `meta`, what else it says, such as `min` and
`actual`. An issue carries no sentence of its own: `issue.message()` writes one from the English
catalogue and `issue.message(Messages.japanese)` from the Japanese one. The only sentence an issue
carries is one its maker gave, which every catalogue leaves as it is.

The codes, message keys and metadata are those of the Raoh Specification, which Raoh for Java, Go,
Rust and PHP follow too, so the same client-side handling works for all of them.

`Issues` keeps them in the order they were found. `flatten()` groups the sentences by path, and
`toJSON()` writes `[{path, code, messageKey, message, meta}]`.

## Combining decoders

`object` reads its fields from the same input and gives their values as a tuple, in order. Every
field is read, so every failing one is reported.

```ts
const point = object(field("x", int()), field("y", int())).strict();
point.decode({ x: "1", y: 2, z: 3 }).issues?.list.map((i) => i.path.toString()); // ["/x", "/z"]
```

A rule that relates the parts runs once the parts exist, with `flatMap`. The paths of the issues it
gives are read below where the decoder is:

```ts
const period = object(field("start", int()), field("end", int())).flatMap(([start, end]) =>
  start <= end
    ? ok({ start, end })
    : failed(new Issue("invalid_value", { message: "must not be before start", path: ["end"] })),
);
```

`discriminate("type", { circle, square })` reads the variant a tag names, and its type is the
union of the variants'. `oneOf(a, b)` gives the first candidate that succeeds. `enumOf`,
`literal`, `list`, `dict`, `optionalField`, `optionalNullableField`, `flat`, `nullable`,
`withDefault` and `recover` are as the specification describes them.

## Input

A decoder reads the input model of the specification: what a JSON text denotes, with every number
kept as it is written. `parse(text)` and `decoder.decodeJson(text)` read a JSON text into it, every
number a `JsonNumber` holding its lexeme and every object a `Map` holding its members in order.

A decoder also reads what an application already has: plain objects, arrays, strings, booleans,
`null`, and numbers as JavaScript `number` or `bigint`. `undefined` is an absent value. Such a
number has already been converted, so a decoder reads the number it is, not the text it was:
`1.50` read by `JSON.parse` is 1.5, and `decimal()` gives it with scale 1; an integer beyond 2⁵³
has already been rounded. Read the text with `parse` where that matters.

The values a decoder gives are a `number` for `int`, `float` and `double`, a `bigint` for `long`, a
`Decimal` (a coefficient and a scale) for `decimal`, a `ValueSet` for `toSet`, which tells +0 from
-0 as a JavaScript `Set` does not, and a `Map` for `dict`.

## Conformance

raoh-ts is checked against the [Raoh Specification](https://github.com/raoh-project/raoh-specification)
at the commit `conformance/spec.lock` pins, with the verifier of that commit:

```sh
scripts/conformance.sh
```

Raoh Specification 0.9.0-dev — core: partially conformant (314 unsupported); encode: conformant;
messages-en: conformant; messages-ja: conformant.

The unsupported features are the ones that read text by the rules
[199x-notation](https://github.com/raoh-project/199x-notation) gives: `trim`, `nonBlank`,
`toLowerCase`, `toUpperCase`, `normalize`, `pattern`, and the temporal decoders and their
operations. JavaScript's own `normalize`, case mapping and `RegExp` follow whichever Unicode
version the engine has, so they are left out until raoh-ts reads text with 199x-notation, rather
than given with answers that differ from one engine to another. `conformance/conformance.json`
lists them.

## License

Apache License 2.0
