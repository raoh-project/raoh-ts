// Writing an issue's message in a person's language.

import { CATALOG } from "./catalog.ts";
import type { Issue } from "./issue.ts";
import { messageForm } from "./meta.ts";

/** Writes the sentence for an issue that carries no message of its own. */
export interface MessageResolver {
  resolve(issue: Issue): string;
}

/** The message key of an issue for text that is not JSON, which the specification leaves outside its input model. */
export const INVALID_FORMAT_JSON = "invalid_format.json";

/**
 * A catalogue of message templates keyed by message key or code, over the catalogue it falls
 * back to.
 *
 * A catalogue is a stack of layers, most specific first, as Raoh for Java reads a locale's
 * `.properties` file before its parent's. An issue is looked up one layer at a time, by its
 * message key and then by its code, and only when neither has a template does the next layer down
 * get asked. So a layer that translates just `invalid_format` wins over a refined key such as
 * `invalid_format.email` beneath it. A template's `{name}` placeholders are filled with the
 * message forms of the issue's metadata; a placeholder naming an entry the metadata lacks stays as
 * it is written. Where no layer has a template, the sentence is `validation failed: <code>`.
 */
export class Messages implements MessageResolver {
  readonly #templates: ReadonlyMap<string, string>;
  readonly #parent: Messages | undefined;

  private constructor(templates: ReadonlyMap<string, string>, parent: Messages | undefined) {
    this.#templates = templates;
    this.#parent = parent;
  }

  /** The English catalogue of the Raoh Specification. Every issue's default message comes from it. */
  static readonly english: Messages = Messages.fromProperties(CATALOG.en).withOverrides({
    [INVALID_FORMAT_JSON]: "not valid JSON",
  });

  /** The Japanese catalogue of the Raoh Specification, over the English one. */
  static readonly japanese: Messages = Messages.fromProperties(CATALOG.ja)
    .withOverrides({ [INVALID_FORMAT_JSON]: "JSONとして読めません" })
    .fallingBackTo(Messages.english);

  /** A catalogue with no templates, in which every issue reads `validation failed: <code>`. */
  static empty(): Messages {
    return new Messages(new Map(), undefined);
  }

  /**
   * The catalogue a `.properties` text holds, read as Java's `Properties.load` reads one, such as
   * the `messages*.properties` of Raoh for Java: one `raoh.<key>=<template>` per entry, `\uXXXX`
   * escapes and continued lines included. The `raoh.` prefix is optional. The catalogue falls
   * back to nothing; give it one with {@link fallingBackTo}.
   *
   * @throws {SyntaxError} where a `\u` escape is malformed
   */
  static fromProperties(text: string): Messages {
    const templates = new Map<string, string>();
    for (const [key, template] of loadProperties(text)) {
      templates.set(key.startsWith("raoh.") ? key.slice("raoh.".length) : key, template);
    }
    return new Messages(templates, undefined);
  }

  /**
   * The catalogue for a language tag, `ja` or `ja-JP` among them: Japanese for Japanese, and
   * English for any other language.
   */
  static forLocale(locale: string): Messages {
    const language = locale.split(/[-_]/)[0]?.toLowerCase();
    return language === "ja" ? Messages.japanese : Messages.english;
  }

  /** This catalogue with `parent` beneath its last layer, as a locale's file sits over its parent's. */
  fallingBackTo(parent: Messages): Messages {
    return new Messages(this.#templates, this.#parent === undefined ? parent : this.#parent.fallingBackTo(parent));
  }

  /** A layer of `overrides`, keyed by message key or code, over this catalogue. */
  withOverrides(overrides: Readonly<Record<string, string>>): Messages {
    return new Messages(new Map(Object.entries(overrides)), this);
  }

  /** The template the most specific layer holding `key` has, if one does. */
  template(key: string): string | undefined {
    for (let layer: Messages | undefined = this; layer !== undefined; layer = layer.#parent) {
      const template = layer.#templates.get(key);
      if (template !== undefined) {
        return template;
      }
    }
    return undefined;
  }

  /** Every key, and the template the most specific layer holding it has. */
  templates(): Map<string, string> {
    const out = new Map<string, string>();
    for (let layer: Messages | undefined = this; layer !== undefined; layer = layer.#parent) {
      for (const [key, template] of layer.#templates) {
        if (!out.has(key)) {
          out.set(key, template);
        }
      }
    }
    return out;
  }

  resolve(issue: Issue): string {
    for (let layer: Messages | undefined = this; layer !== undefined; layer = layer.#parent) {
      const template = layer.#templates.get(issue.messageKey) ?? layer.#templates.get(issue.code);
      if (template !== undefined) {
        return fill(template, issue.meta);
      }
    }
    return `validation failed: ${issue.code}`;
  }
}

const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_.-]*)\}/g;

/** `template` with each `{name}` replaced by the message form of the entry `name`, or left as written where there is none. */
function fill(template: string, meta: Readonly<Record<string, unknown>>): string {
  return template.replace(PLACEHOLDER, (written, name: string) =>
    Object.prototype.hasOwnProperty.call(meta, name) ? messageForm(meta[name]) : written,
  );
}

/**
 * `Properties.load`: the key and value pairs of a `.properties` text, in order.
 *
 * A logical line continues onto the next when it ends in an odd number of backslashes, and the
 * next line's leading whitespace is skipped. Lines that are blank or whose first character other
 * than whitespace is `#` or `!` are comments. A key ends at the first `=`, `:` or whitespace not
 * escaped; whitespace around the separator is skipped. Both key and value undo the escapes `\t`,
 * `\n`, `\r`, `\f` and `\uXXXX`, and a backslash before any other character stands for that
 * character.
 */
function loadProperties(text: string): [string, string][] {
  const lines = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  const pairs: [string, string][] = [];
  let logical = "";
  let start = 0;
  let continuing = false;
  lines.forEach((raw, index) => {
    let line: string;
    if (continuing) {
      line = raw.replace(/^[ \t\f]+/, "");
    } else {
      line = raw.replace(/^[ \t\f]+/, "");
      if (line === "" || line.startsWith("#") || line.startsWith("!")) {
        return;
      }
      start = index + 1;
    }
    const trailing = line.length - line.replace(/\\+$/, "").length;
    if (trailing % 2 === 1) {
      logical += line.slice(0, -1);
      continuing = true;
    } else {
      logical += line;
      continuing = false;
      pairs.push(entry(logical, start));
      logical = "";
    }
  });
  if (continuing) {
    pairs.push(entry(logical, start));
  }
  return pairs;
}

function entry(line: string, number: number): [string, string] {
  let keyEnd = line.length;
  let escaped = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (escaped) {
      escaped = false;
    } else if (c === "\\") {
      escaped = true;
    } else if (c === "=" || c === ":" || c === " " || c === "\t" || c === "\f") {
      keyEnd = i;
      break;
    }
  }
  let rest = line.slice(keyEnd).replace(/^[ \t\f]+/, "");
  if (rest.startsWith("=") || rest.startsWith(":")) {
    rest = rest.slice(1);
  }
  rest = rest.replace(/^[ \t\f]+/, "");
  return [unescape(line.slice(0, keyEnd), number), unescape(rest, number)];
}

function unescape(raw: string, number: number): string {
  let out = "";
  for (let i = 0; i < raw.length; i += 1) {
    const c = raw[i];
    if (c !== "\\") {
      out += c;
      continue;
    }
    i += 1;
    const next = raw[i];
    switch (next) {
      case undefined:
        break;
      case "t":
        out += "\t";
        break;
      case "n":
        out += "\n";
        break;
      case "r":
        out += "\r";
        break;
      case "f":
        out += "\f";
        break;
      case "u": {
        const hex = raw.slice(i + 1, i + 5);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
          throw new SyntaxError(`line ${number}: malformed \\uXXXX encoding`);
        }
        out += String.fromCharCode(Number.parseInt(hex, 16));
        i += 4;
        break;
      }
      default:
        out += next;
    }
  }
  return out;
}
