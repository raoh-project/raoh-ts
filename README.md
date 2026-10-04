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
Working on raoh-ts itself takes Node 22.18.0 or later, which runs the tests as the TypeScript they
are written in; `package.json` says the first in `engines` and the second in `devEngines`.

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

A catalogue has a template for the issues of the Raoh Specification. A library that gives issues
of its own, which no catalogue knows, says what to write for them with
`Messages.english.withFallback((issue) => ...)`; a catalogue that does have a template for such an
issue still wins over it.

The codes, message keys and metadata are those of the Raoh Specification, which Raoh for Java, Go,
Rust and PHP follow too, so the same client-side handling works for all of them.

`Issues` keeps them in the order they were found. `flatten()` groups the sentences by path.

A path is a JSON Pointer's reference tokens, each kept as its text. RFC 6901 leaves it to the
value a token is applied to whether `0` names a member or an index, and a `Path` says no more
than its pointer does, so `Path.parse(path.toString())` is always the same path.

### Issues as JSON

`JSON.stringify(issues)` writes `[{path, code, messageKey, message, meta}]`, with the English
sentence; `issues.toWire(Messages.japanese)` gives the same with another catalogue's. Each
metadata value is written as the Raoh Specification observes it
([observation.md](https://github.com/raoh-project/raoh-specification/blob/main/spec/observation.md)):

| Value | JSON |
|-------|------|
| int32, int64 | a number, all its digits |
| float32, float64 | its canonical decimal as a number (`0.1` for the float32 nearest 0.1, `1.0E7`), or `{"float": "-0"}`, `{"float": "NaN"}`, `{"float": "+Infinity"}`, `{"float": "-Infinity"}` |
| decimal | a string, at its scale (`"1.50"`, `"1E+3"`) |
| list | an array |
| the candidates of `one_of_failed` | an array of `{candidate, issues}`, each issue `{path, code, message, meta}` with no `messageKey`, as the specification observes the issues type |

No number is rounded on the way out: an int64 beyond 2⁵³ is written with all its digits through
`JSON.rawJSON`. On an engine that has no `JSON.rawJSON`, a number that a JavaScript number would
change makes `JSON.stringify` throw a `RangeError`, rather than write another number.

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
`null`, and numbers as JavaScript `number` or `bigint`, or as `JSON.rawJSON` makes them, which
keeps their text. `undefined` is an absent value. An object is a `Map` of string keys, or an object
whose data are its own properties. What the input model has no place for — a string holding an
unpaired surrogate, an array with a hole, a `Date`, a `Set`, a `String` object — is refused with a
`TypeError` rather than read as some other value. Such a
number has already been converted, so a decoder reads the number it is, not the text it was:
`1.50` read by `JSON.parse` is 1.5, and `decimal()` gives it with scale 1; an integer beyond 2⁵³
has already been rounded. Read the text with `parse` where that matters.

`stringify(value)` writes a value of the input model back as JSON text, reading it by the same
rule, so that whatever it writes `parse` reads back as the value it was:
each number as its lexeme and each object's members in order. It is how a value is handed on to
something that reads JSON text, without a number rounded or a member moved, which
`JSON.stringify` does to a `Map` and to an object's integer-like member names.

The values a decoder gives are a `number` for `int`, `float` and `double`, a `bigint` for `long`, a
`Decimal` (a coefficient and a scale) for `decimal`, a `ValueSet` for `toSet`, which tells +0 from
-0 as a JavaScript `Set` does not, and a `Map` for `dict`.

## A library built on Raoh

A library whose decoders, issues or paths an application combines with its own, as Souther's
`@souther/wasm` offers each type of a model as a `Decoder`, depends on `@raoh/core` as a peer
dependency, so that the library and the application share one copy. A value one copy made is no
instance of another copy's classes; where one is met anyway, such as a `Path` or a `JsonNumber` of
another copy, it is refused with a `TypeError` that says so, rather than read as some other value.

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

## Releasing

`@raoh/core` is published by the `Publish` workflow and by nothing else. `package.json` on `develop`
holds the next version as `X.Y.Z-dev`, and each commit on `develop` is published, once CI has passed
on it, as that version followed by the time of the commit and the commit,
`X.Y.Z-dev.YYYYMMDDHHMMSS.gHHHHHHHHHHHH`, under the dist-tag `dev`. npm takes a version once and
never again, so a development version is a commit, as a timestamped Maven snapshot is: the commit
makes two commits two versions, which the time alone does not, and the time puts them in the order
they were made. No range of versions a project writes reaches one, so only a project that names it
exactly gets it. `npm install @raoh/core` takes `latest`, which is a release. `scripts/publish.sh`
says what version a ref makes and publishes it, and CI runs it as a dry run for a development
version and for a release on every pull request, so the path a tag takes is taken before a tag is
pushed:

1. On a branch from `develop`, set `package.json`'s version to `X.Y.Z` and open a pull request to
   `main`.
2. Merge it, and tag the merge commit on `main` `vX.Y.Z`. The workflow fails a tag that is not `v`
   and a version, that is not the version `package.json` holds, or that names a commit not on
   `main`. It runs the whole of CI on the commit, and only once that passes publishes `X.Y.Z` under
   `latest`.
3. Merge `main` back into `develop`, and set `package.json` there to `<next version>-dev`.

The workflow logs in with nothing: npm proves to the registry that it runs in this workflow of this
repository, which the package's settings on npmjs.com name as its trusted publisher, and the
registry records with each version the commit and the run it was built in. A trusted publisher is
named for a package that exists, so the package's first version is published by hand from a
checkout, and the trusted publisher named after it: `raoh-project/raoh-ts`, workflow `publish.yml`.

## License

Apache License 2.0
