// Runs the cases of the Raoh Specification on raoh-ts and writes a runner result
// (spec/conformance.md), which raoh-verify checks against conformance/conformance.json.
// scripts/conformance.sh runs both.

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { arch, platform } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { type Decoder, Messages, parse } from "../src/index.ts";
import { CATALOG } from "../src/catalog.ts";
import { Binder, Catalog } from "./bind.ts";
import { observe, writeIssue } from "./value.ts";

/**
 * Every feature the runner has a binding of, as the catalogue names it. A feature the catalogue
 * has and this does not is not bound, so the cases that need it are not run and the verifier
 * reports them.
 */
const BINDS = `
decoder.string decoder.int decoder.long decoder.float decoder.double decoder.decimal decoder.bool
decoder.list decoder.dict decoder.object decoder.strictObject decoder.strict decoder.nullable
decoder.enum decoder.enum.message decoder.literal decoder.literal.message decoder.discriminate
decoder.discriminateBy decoder.oneOf decoder.withDefault decoder.recover decoder.recoverWith
field.field field.optionalField field.optionalNullableField field.flat
encoder.string encoder.object property.propertyWithDefault
fixture.first fixture.square_side fixture.square fixture.area fixture.shift_add_10
fixture.shift_add_100 fixture.shift_add_1000 fixture.decimal_string fixture.even
fixture.ordered_period fixture.issue_count_plus_10 fixture.identity
operation.any.map operation.any.refine operation.any.flatMap
`;

/** The operations bound on each kind of receiver, each with its `.message` facet where the catalogue gives it one. */
const OPERATIONS: Record<string, string> = {
  string:
    "minLength maxLength fixedLength oneOf startsWith endsWith includes email ipv4 ipv6 ip ulid cuid uuid url uri " +
    "toInt toLong toDecimal toBool trim nonBlank toLowerCase toUpperCase normalize pattern date time dateTime " +
    "offsetDateTime iso8601",
  int32: "min max range positive negative nonNegative nonPositive oneOf multipleOf",
  int64: "min max range positive negative nonNegative nonPositive oneOf multipleOf",
  float32: "min max range positive negative nonNegative nonPositive oneOf",
  float64: "min max range positive negative nonNegative nonPositive oneOf",
  decimal: "min max range positive negative nonNegative nonPositive multipleOf scale",
  bool: "isTrue",
  list: "nonempty minSize maxSize fixedSize unique contains containsAll toSet",
  map: "nonempty minSize maxSize fixedSize",
  date: "before after between",
  time: "before after between",
  datetime: "before after between",
  offset_datetime: "before after between",
  instant: "before after between",
};

function binds(): Set<string> {
  const out = new Set(BINDS.split(/\s+/).filter((f) => f !== ""));
  for (const [kind, names] of Object.entries(OPERATIONS)) {
    for (const name of names.split(" ")) {
      out.add(`operation.${kind}.${name}`);
      out.add(`operation.${kind}.${name}.message`);
    }
  }
  return out;
}

interface Args {
  spec: string;
  revision: string;
  manifestDigest: string;
  implementationRevision: string;
  out: string;
}

function args(): Args {
  const { values } = parseArgs({
    options: {
      spec: { type: "string" },
      revision: { type: "string" },
      "manifest-digest": { type: "string" },
      "implementation-revision": { type: "string" },
      out: { type: "string" },
    },
  });
  const required = (name: keyof typeof values): string => {
    const value = values[name];
    if (value === undefined) {
      throw new Error(`--${name} is required`);
    }
    return value;
  };
  return {
    spec: required("spec"),
    revision: required("revision"),
    manifestDigest: required("manifest-digest"),
    implementationRevision: required("implementation-revision"),
    out: required("out"),
  };
}

type Operations = ConstructorParameters<typeof Catalog>[0] & {
  fields: Record<string, unknown>;
  encoders: Record<string, unknown>;
  properties: Record<string, unknown>;
  constructors: Record<string, { args?: { kind: string }[] }>;
  operations: { name: string; receivers: string[]; args?: { kind: string }[] }[];
};

/**
 * The features the catalogue has: its constructors, fields, operations on each kind of receiver,
 * encoders, properties and fixtures, with the `.message` facet of each form that takes one.
 */
function catalogueFeatures(operations: Operations, fixtures: Record<string, unknown>): Set<string> {
  const out = new Set<string>();
  const takesMessage = (args: { kind: string }[] | undefined) => (args ?? []).some((a) => a.kind === "message");
  for (const [name, c] of Object.entries(operations.constructors)) {
    out.add(`decoder.${name}`);
    if (takesMessage(c.args)) {
      out.add(`decoder.${name}.message`);
    }
  }
  for (const [section, prefix] of [
    ["fields", "field"],
    ["encoders", "encoder"],
    ["properties", "property"],
  ] as const) {
    for (const name of Object.keys(operations[section])) {
      out.add(`${prefix}.${name}`);
    }
  }
  for (const o of operations.operations) {
    for (const receiver of o.receivers) {
      const outer = receiver.split("<")[0] as string;
      const kind = outer === "*" ? "any" : outer;
      out.add(`operation.${kind}.${o.name}`);
      if (takesMessage(o.args)) {
        out.add(`operation.${kind}.${o.name}.message`);
      }
    }
  }
  for (const name of Object.keys(fixtures)) {
    out.add(`fixture.${name}`);
  }
  return out;
}

/** What a case observed; `undefined` where it needs a feature the runner does not bind. */
function runCase(c: Map<string, unknown>, catalog: Catalog, bound: Set<string>): unknown {
  const binder = new Binder(catalog);
  let observed: unknown;
  try {
    if (c.has("encoder")) {
      observed = { ok: binder.encode(c.get("encoder"), c.get("value")) };
    } else {
      const { decoder, ty } = binder.decoder(c.get("decoder"));
      const read = (decoder as Decoder<unknown>).decode(c.get("input"));
      observed =
        read.issues === undefined ? { ok: observe(ty, read.value) } : { issues: read.issues.list.map(writeIssue) };
    }
  } catch (e) {
    observed = { error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
  }
  for (const feature of binder.used) {
    if (!bound.has(feature)) {
      return undefined;
    }
  }
  return observed;
}

/** Each locale's catalogue as this library ships it: the text of the specification's, read as it reads it. */
function catalogs(): Record<string, Record<string, string>> {
  return {
    en: Object.fromEntries(Messages.fromProperties(CATALOG.en).templates()),
    ja: Object.fromEntries(Messages.fromProperties(CATALOG.ja).templates()),
  };
}

function run({ spec, revision, manifestDigest, implementationRevision, out }: Args): void {
  const json = (path: string) => JSON.parse(readFileSync(join(spec, path), "utf8"));
  const version = (json("specification.json") as { version: string }).version;
  const operations = json("catalog/operations.json") as Operations;
  const fixtures = json("catalog/fixtures.json") as Record<string, unknown>;
  const catalog = new Catalog(operations);
  const binding = binds();
  const bound = new Set([...catalogueFeatures(operations, fixtures)].filter((f) => binding.has(f)));

  const results: Record<string, { observed: unknown }> = {};
  for (const profile of ["core", "encode"]) {
    const dir = join(spec, "suite", profile);
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
      // The cases are read as the input model reads them, so that each input is handed to its
      // decoder with its lexemes and its member order as the file writes them.
      const cases = parse(readFileSync(join(dir, file), "utf8"));
      if (!Array.isArray(cases)) {
        throw new Error(`${file} is not an array of cases`);
      }
      for (const c of cases as Map<string, unknown>[]) {
        const id = c.get("id");
        if (typeof id !== "string") {
          throw new Error(`a case of ${file} has no id`);
        }
        const observed = runCase(c, catalog, bound);
        if (observed !== undefined) {
          Object.defineProperty(results, id, { value: { observed }, enumerable: true });
        }
      }
    }
  }

  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  const result = {
    format: "raoh-runner-result/v1",
    specification: { version, revision, manifest_digest: manifestDigest },
    implementation: { name: "raoh-ts", version: pkg.version, revision: implementationRevision },
    environment: { language: "typescript", language_version: `node ${process.versions.node}`, os: platform(), arch: arch() },
    bound_features: [...bound].sort(),
    results,
    catalogs: catalogs(),
  };
  writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
}

try {
  run(args());
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
