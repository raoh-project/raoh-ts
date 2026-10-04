// The fixtures of catalog/fixtures.json, written as a user of Raoh writes such functions
// (spec/fixtures.md).

import { Issue, type Issues, type Result, failed, ok } from "../src/index.ts";
import { T, type Ty } from "./value.ts";

/** A `map` fixture: its output type for the input type `input`, and the function. */
export function mapFixture(name: string, input: Ty): [Ty, (value: unknown) => unknown] {
  const ints = (value: unknown) => value as number[];
  const shiftAdd = (by: number) => (value: unknown) => {
    const [a, b] = ints(value) as [number, number];
    return a * by + b;
  };
  switch (name) {
    case "first":
      if (input.kind !== "product" || input.parts.length !== 1) {
        throw new Error(`first takes a product of one element, not ${JSON.stringify(input)}`);
      }
      return [input.parts[0] as Ty, (value) => (value as unknown[])[0]];
    case "square_side":
    case "square":
      return [T.int32, (value) => (ints(value)[0] as number) ** 2];
    case "area":
      return [T.int32, (value) => (ints(value)[0] as number) * (ints(value)[1] as number)];
    case "shift_add_10":
      return [T.int32, shiftAdd(10)];
    case "shift_add_100":
      return [T.int32, shiftAdd(100)];
    case "shift_add_1000":
      return [T.int32, shiftAdd(1000)];
    case "decimal_string":
      return [T.string, (value) => String(value)];
    default:
      throw new Error(`no map fixture ${name}`);
  }
}

/** The `refine` fixture `even`, as a user writes a check with an issue of their own. */
export function even(value: unknown): boolean {
  return (value as number) % 2 === 0;
}

export function notEven(value: unknown): Issue {
  return new Issue("must_be_even", { message: "must be even", meta: { actual: value } });
}

/**
 * The `flatMap` fixture `ordered_period`: the product unchanged where start <= end, and otherwise
 * an issue at `end`, relative to where the decoder is.
 */
export function orderedPeriod(value: unknown): Result<unknown> {
  const [start, end] = value as [number, number];
  return start <= end ? ok(value) : failed(new Issue("invalid_value", { message: "end is before start", path: ["end"] }));
}

/** The `recover` fixture `issue_count_plus_10`. */
export function issueCountPlus10(issues: Issues): number {
  return issues.length + 10;
}
