// Where in the input an issue is.

/** A step into the input: an object member's name, or an array element's index. */
export type Segment = string | number;

/**
 * A path into the input, kept as its segments and written as a JSON Pointer (RFC 6901) only when
 * it is reported, so that a segment is escaped exactly once.
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

  /** The path of the given segments, from the root. */
  static of(...segments: readonly Segment[]): Path {
    let path = Path.ROOT;
    for (const segment of segments) {
      path = path.child(segment);
    }
    return path;
  }

  /**
   * The path a JSON Pointer writes. A segment of decimal digits is read as an index; a pointer
   * does not say which it was, and an index is what such a segment names in an array.
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
      const segment = written.replaceAll("~1", "/").replaceAll("~0", "~");
      path = path.child(/^(0|[1-9][0-9]*)$/.test(segment) ? Number(segment) : segment);
    }
    return path;
  }

  /** The path one step below this one. */
  child(segment: Segment): Path {
    return new Path(this, segment);
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
      .map((segment) => `/${String(segment).replaceAll("~", "~0").replaceAll("/", "~1")}`)
      .join("");
  }

  toJSON(): string {
    return this.toString();
  }
}
