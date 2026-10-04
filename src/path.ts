// Where in the input an issue is.

/**
 * A step into the input: a reference token of a JSON Pointer (RFC 6901). It is the name of an
 * object's member or the index of an array's element, written in decimal; which one is for the
 * value it is applied to to say, as RFC 6901 has it, so a path holds the text and nothing more.
 */
export type Segment = string;

/**
 * A path into the input, kept as its segments and written as a JSON Pointer only when it is
 * reported, so that a segment is escaped exactly once. A path holds what its pointer writes and
 * no more, so reading back what it writes gives the same path.
 *
 * A path is immutable. Walking down the input makes a child that points at its parent, so a
 * successful decode copies no segments.
 */
export class Path {
  /** The input itself. */
  static readonly ROOT: Path = new Path(undefined, undefined);

  readonly #parent: Path | undefined;
  readonly #segment: Segment | undefined;

  private constructor(parent: Path | undefined, segment: Segment | undefined) {
    this.#parent = parent;
    this.#segment = segment;
  }

  /** The path of the given segments, from the root; an index is its decimal text. */
  static of(...segments: readonly (string | number)[]): Path {
    let path = Path.ROOT;
    for (const segment of segments) {
      path = path.child(segment);
    }
    return path;
  }

  /**
   * The path a JSON Pointer writes, each reference token unescaped and kept as its text.
   *
   * @throws {SyntaxError} when the text is not a JSON Pointer
   */
  static parse(pointer: string): Path {
    if (pointer === "") {
      return Path.ROOT;
    }
    if (!pointer.startsWith("/")) {
      throw new SyntaxError(`${JSON.stringify(pointer)} is not a JSON Pointer`);
    }
    let path = Path.ROOT;
    for (const written of pointer.slice(1).split("/")) {
      if (/~(?![01])/.test(written)) {
        throw new SyntaxError(`${JSON.stringify(pointer)} has a ~ that is not ~0 or ~1`);
      }
      path = path.child(written.replaceAll("~1", "/").replaceAll("~0", "~"));
    }
    return path;
  }

  /**
   * The path one step below this one. An index is held as its decimal text, the token a
   * pointer writes for it.
   *
   * @throws {RangeError} for a number that is not an index: negative, fractional, or beyond
   *   the integers a JavaScript number holds exactly
   */
  child(segment: string | number): Path {
    if (typeof segment === "number" && !(Number.isSafeInteger(segment) && segment >= 0)) {
      throw new RangeError(`${segment} is not an array index`);
    }
    return new Path(this, String(segment));
  }

  /** `relative`, read as starting where this path ends. */
  concat(relative: Path): Path {
    let path: Path = this;
    for (const segment of relative.segments()) {
      path = path.child(segment);
    }
    return path;
  }

  /** Whether this is the input itself. */
  get isRoot(): boolean {
    return this.#parent === undefined;
  }

  /** The segments from the root. */
  segments(): Segment[] {
    const out: Segment[] = [];
    for (let at: Path = this; at.#parent !== undefined; at = at.#parent) {
      out.push(at.#segment as Segment);
    }
    return out.reverse();
  }

  /** Whether the two paths have the same segments. */
  equals(other: Path): boolean {
    let a: Path | undefined = this;
    let b: Path | undefined = other;
    while (a !== undefined && b !== undefined) {
      if (a === b) {
        return true;
      }
      if (a.#segment !== b.#segment) {
        return false;
      }
      a = a.#parent;
      b = b.#parent;
    }
    return a === b;
  }

  /** The path as a JSON Pointer: `""` for the root, `/items/0/name` below it. */
  toString(): string {
    return this.segments()
      .map((segment) => `/${segment.replaceAll("~", "~0").replaceAll("/", "~1")}`)
      .join("");
  }

  toJSON(): string {
    return this.toString();
  }
}
