// Telling a value of this copy of the library from one of another copy.
//
// A program can come to hold two copies of @raoh/core: a library built on Raoh that brings its own,
// and the application's. A value one copy made is then no instance of the other's class, and a
// check by `instanceof` would read it as some other value without a word: a JsonNumber written as
// an object, a Path walked as if it were a list. Every class here carries its name as its
// `Symbol.toStringTag`, which a copy shares with every other, so a value of the same class from
// another copy is refused where it is met, as the mistake in how the program was installed that it
// is. One copy is what a peer dependency on @raoh/core gives a library and its application.

const PREFIX = "@raoh/core ";

/** The `Symbol.toStringTag` of this library's class `name`, the same in every copy of it. */
export function tagOf(name: string): string {
  return PREFIX + name;
}

/**
 * Whether `value` is an instance of `type`, this copy's class `name`. The class is typed by its
 * prototype, since a class with a private constructor is no type `new` can be asked of.
 *
 * @throws {TypeError} where it is an instance of the class of that name another copy has
 */
export function ofThisCopy<T extends object>(value: unknown, type: Function & { readonly prototype: T }, name: string): value is T {
  if (value instanceof type) {
    return true;
  }
  if (typeof value === "object" && value !== null && (value as { [Symbol.toStringTag]?: unknown })[Symbol.toStringTag] === PREFIX + name) {
    throw new TypeError(
      `a ${name} made by another copy of @raoh/core: a library built on Raoh and the application using it have to `
        + "share one, which the library's peer dependency on @raoh/core gives them",
    );
  }
  return false;
}
