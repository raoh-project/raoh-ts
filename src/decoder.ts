// A value that describes how to read an input, and the ways decoders compose.

import { parse } from "./input.ts";
import { Issue, Issues, type Result, failed, ok } from "./issue.ts";
import { INVALID_FORMAT_JSON } from "./messages.ts";
import { Path } from "./path.ts";

/** How a decoder reads an input at a path. */
export type Run<T> = (input: unknown, path: Path) => Result<T>;

/**
 * Reads a value of the input model into a `T`, or says everything that kept it from being one.
 *
 * What a decoder gives depends on the input alone, so a decoder can be kept and shared. An absent
 * value is `undefined`: a missing member of an object is handed to its decoder as `undefined`,
 * and decoders tell it from `null` where they say so.
 */
export abstract class Decoder<T> {
  /** Reads `input`, which is at `path` in what is being decoded; every issue is at a path below it. */
  abstract decodeAt(input: unknown, path: Path): Result<T>;

  /**
   * A value this decoder gives, as an issue's metadata holds it. A float decoder's value is held
   * with its width, so that the message writes it as a float of that width; every other value is
   * held as it is.
   */
  metaValue(value: T): unknown {
    return value;
  }

  /** Reads `input` as the whole of what is being decoded. */
  decode(input: unknown): Result<T> {
    return this.decodeAt(input, Path.ROOT);
  }

  /**
   * Reads a JSON text: its numbers as written, its members in order. Text that is not JSON gives
   * `invalid_format` under the message key `invalid_format.json`, at the root.
   */
  decodeJson(text: string): Result<T> {
    let input: unknown;
    try {
      input = parse(text);
    } catch (e) {
      if (e instanceof SyntaxError) {
        return failed(new Issue("invalid_format", { messageKey: INVALID_FORMAT_JSON }));
      }
      throw e;
    }
    return this.decode(input);
  }

  /** A decoder giving what `f` makes of this one's value. */
  map<U>(f: (value: T) => U): Decoder<U> {
    return decoder((input, path) => {
      const read = this.decodeAt(input, path);
      return read.issues === undefined ? ok(f(read.value)) : read;
    });
  }

  /**
   * A decoder giving what `f` makes of this one's value, which may be a failure: a rule that
   * relates the parts of a value, checked once they exist. The paths of the issues `f` gives are
   * read as relative to where this decoder is.
   */
  flatMap<U>(f: (value: T) => Result<U>): Decoder<U> {
    return decoder((input, path) => {
      const read = this.decodeAt(input, path);
      if (read.issues !== undefined) {
        return read;
      }
      const made = f(read.value);
      return made.issues === undefined ? made : failed(made.issues.under(path));
    });
  }

  /**
   * This decoder, failing with `issue` where `predicate` does not hold of its value. The issue is
   * given at this decoder's path, or below it where it has a path of its own.
   */
  refine(predicate: (value: T) => boolean, issue: Issue | ((value: T) => Issue)): Decoder<T> {
    return this.flatMap((value) => (predicate(value) ? ok(value) : failed(typeof issue === "function" ? issue(value) : issue)));
  }

  /** A decoder giving `null` for a JSON null, and reading anything else, absence included, with this one. */
  nullable(): Decoder<T | null> {
    return nullable(this);
  }

  /** A decoder giving `fallback` for a JSON null or an absent value, and reading anything else with this one. */
  withDefault(fallback: T): Decoder<T> {
    return withDefault(this, fallback);
  }

  /** This decoder, giving `fallback` instead of any failure. */
  recover(fallback: T): Decoder<T> {
    return recover(this, fallback);
  }

  /** This decoder, giving what `f` makes of the issues instead of any failure. */
  recoverWith(f: (issues: Issues) => T): Decoder<T> {
    return recoverWith(this, f);
  }
}

/** A decoder that reads as `run` does. */
export function decoder<T>(run: Run<T>): Decoder<T> {
  return new Chain(run);
}

/**
 * A decoder made of how it reads, to which checks are added one after another: each runs only
 * where everything before it succeeded, and the decoder it makes is of the same class, so that
 * the checks of that class can follow it.
 */
export class Chain<T> extends Decoder<T> {
  readonly #run: Run<T>;

  constructor(run: Run<T>) {
    super();
    this.#run = run;
  }

  decodeAt(input: unknown, path: Path): Result<T> {
    return this.#run(input, path);
  }

  /** A decoder of this class that reads as `run` does. */
  protected derive(run: Run<T>): this {
    return new (this.constructor as new (run: Run<T>) => this)(run);
  }

  /**
   * This decoder, then `test` of its value: the issue it gives, at this decoder's path, with
   * `message` as its sentence where one is given.
   */
  protected check(test: (value: T) => Issue | undefined, message?: string): this {
    return this.derive(this.then(test, message));
  }

  /** How this decoder reads, then `test` of its value. */
  protected then(test: (value: T) => Issue | undefined, message?: string): Run<T> {
    return this.convert((value) => {
      const issue = test(value);
      return issue === undefined ? ok(value) : failed(issue);
    }, message);
  }

  /**
   * How this decoder reads, then what `f` makes of its value: the issues it gives at this
   * decoder's path, each with `message` as its sentence where one is given.
   */
  protected convert<U>(f: (value: T) => Result<U>, message?: string): Run<U> {
    return (input, path) => {
      const read = this.decodeAt(input, path);
      if (read.issues !== undefined) {
        return read;
      }
      const made = f(read.value);
      if (made.issues === undefined) {
        return made;
      }
      const issues = message === undefined ? made.issues.list : made.issues.list.map((issue) => issue.withMessage(message));
      return failed(new Issues(issues).under(path));
    };
  }
}

/** A decoder that reads as `run` does and gives values of `inner`'s kind, which it holds as metadata as `inner` does. */
class Around<T> extends Decoder<T> {
  readonly #run: Run<T>;
  readonly #inner: Decoder<NonNullable<T>>;

  constructor(inner: Decoder<NonNullable<T>>, run: Run<T>) {
    super();
    this.#inner = inner;
    this.#run = run;
  }

  decodeAt(input: unknown, path: Path): Result<T> {
    return this.#run(input, path);
  }

  metaValue(value: T): unknown {
    return value === null || value === undefined ? value : this.#inner.metaValue(value);
  }
}

/** A decoder giving `null` for a JSON null, and reading anything else, absence included, with `inner`. */
export function nullable<T>(inner: Decoder<T>): Decoder<T | null> {
  return new Around(inner as Decoder<NonNullable<T>>, (input, path) => (input === null ? ok(null) : inner.decodeAt(input, path)));
}

/** A decoder giving `fallback` for a JSON null or an absent value, and reading anything else with `inner`. */
export function withDefault<T>(inner: Decoder<T>, fallback: T): Decoder<T> {
  return new Around(inner as Decoder<NonNullable<T>>, (input, path) =>
    input === null || input === undefined ? ok(fallback) : inner.decodeAt(input, path),
  );
}

/** `inner`, giving `fallback` instead of any failure. */
export function recover<T>(inner: Decoder<T>, fallback: T): Decoder<T> {
  return recoverWith(inner, () => fallback);
}

/** `inner`, giving what `f` makes of the issues instead of any failure. */
export function recoverWith<T>(inner: Decoder<T>, f: (issues: Issues) => T): Decoder<T> {
  return new Around(inner as Decoder<NonNullable<T>>, (input, path) => {
    const read = inner.decodeAt(input, path);
    return read.issues === undefined ? read : ok(f(read.issues));
  });
}
