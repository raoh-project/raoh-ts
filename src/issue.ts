// What a decoder that fails gives, and what decoding comes to.

import { type MessageResolver, Messages } from "./messages.ts";
import { Path } from "./path.ts";
import { type IssueWire, issueWire } from "./wire.ts";

/** What an issue is made with, besides its code. */
export interface IssueInit {
  /** The kind of problem within the code's class; the code itself when not given. */
  readonly messageKey?: string;
  /** Named values that describe the problem. */
  readonly meta?: Readonly<Record<string, unknown>>;
  /** A sentence of the issue's own, which every catalogue leaves as it is. */
  readonly message?: string;
  /** Where the problem is, relative to where the issue is given. */
  readonly path?: Path | readonly (string | number)[];
}

/**
 * One thing the input did wrong: where it is, its code, the message key that says which kind of
 * problem within the code it is, and the metadata that describes it.
 *
 * An issue carries no sentence unless whoever made it gave one. {@link message} writes one from a
 * catalogue, the English one unless another is given, so the same issue reads in each person's
 * language.
 */
export class Issue {
  readonly path: Path;
  readonly code: string;
  readonly messageKey: string;
  readonly meta: Readonly<Record<string, unknown>>;
  /** The sentence the issue was given, if it was given one. */
  readonly givenMessage: string | undefined;

  constructor(code: string, init: IssueInit = {}) {
    this.code = code;
    this.messageKey = init.messageKey ?? code;
    this.meta = Object.freeze({ ...init.meta });
    this.givenMessage = init.message;
    this.path = init.path === undefined ? Path.ROOT : init.path instanceof Path ? init.path : Path.of(...init.path);
  }

  /** The sentence for the issue: the one it was given, or the one `resolver` writes. */
  message(resolver: MessageResolver = Messages.english): string {
    return this.givenMessage ?? resolver.resolve(this);
  }

  /** The same issue with `message` as its sentence. */
  withMessage(message: string): Issue {
    return this.#with({ message });
  }

  /** The same issue, its path read as starting at `base`. */
  under(base: Path): Issue {
    return base.isRoot ? this : this.#with({ path: base.concat(this.path) });
  }

  #with(changes: Partial<IssueInit>): Issue {
    return new Issue(this.code, {
      messageKey: this.messageKey,
      meta: this.meta,
      message: this.givenMessage,
      path: this.path,
      ...changes,
    });
  }

  /**
   * The issue as JSON, with its English sentence; {@link issueWire} writes it with another
   * catalogue's. It takes no argument: `JSON.stringify` hands `toJSON` the member name.
   */
  toJSON(): IssueWire {
    return issueWire(this);
  }
}

/** The issues a failed decode gives, in the order they were found; never empty. */
export class Issues implements Iterable<Issue> {
  readonly #list: readonly Issue[];

  constructor(issues: readonly Issue[]) {
    if (issues.length === 0) {
      throw new RangeError("a failure has at least one issue");
    }
    this.#list = Object.freeze([...issues]);
  }

  get length(): number {
    return this.#list.length;
  }

  /** The issues, in order. */
  get list(): readonly Issue[] {
    return this.#list;
  }

  [Symbol.iterator](): Iterator<Issue> {
    return this.#list[Symbol.iterator]();
  }

  /** The same issues, their paths read as starting at `base`. */
  under(base: Path): Issues {
    return base.isRoot ? this : new Issues(this.#list.map((issue) => issue.under(base)));
  }

  /** The sentences for the issues, grouped by the JSON Pointer of their path. */
  flatten(resolver: MessageResolver = Messages.english): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const issue of this.#list) {
      const path = issue.path.toString();
      (out[path] ??= []).push(issue.message(resolver));
    }
    return out;
  }

  /** The issues as JSON, in order, their sentences written by `resolver`. */
  toWire(resolver: MessageResolver = Messages.english): IssueWire[] {
    return this.#list.map((issue) => issueWire(issue, resolver));
  }

  /** The issues as JSON, in order, with their English sentences. */
  toJSON(): IssueWire[] {
    return this.toWire();
  }
}

/** What decoding came to when it succeeded. */
export interface Ok<T> {
  readonly value: T;
  readonly issues?: undefined;
}

/** What decoding came to when it failed. */
export interface Failed {
  readonly issues: Issues;
  readonly value?: undefined;
}

/** What decoding comes to: the value, or the issues that kept it from being one. */
export type Result<T> = Ok<T> | Failed;

/** A success holding `value`. */
export function ok<T>(value: T): Ok<T> {
  return { value };
}

/** A failure with the issues given. */
export function failed(issues: Issues | Issue | readonly Issue[]): Failed {
  return { issues: issues instanceof Issues ? issues : new Issues(issues instanceof Issue ? [issues] : issues) };
}
