// Recognizers for the text formats the string operations read: e-mail addresses, IP addresses,
// ULIDs, CUIDs, UUIDs and URIs. Each is written from the RFC it names, in ASCII.

const ATEXT = "A-Za-z0-9!#$%&'*+\\-/=?^_`{|}~";
const LOCAL_PART = new RegExp(`^[${ATEXT}]+(?:\\.[${ATEXT}]+)*$`);
const LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;

/**
 * Whether `text` is in the ASCII lexical profile of RFC 5321's Mailbox the `email` operation
 * reads: atoms of atext joined by single dots, of at most 64 octets, `@`, and labels joined by
 * single dots, each at most 63 octets, the domain at most 255 and the whole at most 254.
 */
export function isEmail(text: string): boolean {
  const at = text.lastIndexOf("@");
  if (at < 0 || text.length > 254) {
    return false;
  }
  const local = text.slice(0, at);
  const domain = text.slice(at + 1);
  return (
    local.length <= 64 &&
    LOCAL_PART.test(local) &&
    domain.length <= 255 &&
    domain.split(".").every((label) => label.length <= 63 && LABEL.test(label))
  );
}

const DEC_OCTET = "(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9][0-9]|[0-9])";
const IPV4 = new RegExp(`^${DEC_OCTET}(?:\\.${DEC_OCTET}){3}$`);

/** Whether `text` is RFC 3986's IPv4address: four decimal numbers from 0 to 255, no leading zero. */
export function isIpv4(text: string): boolean {
  return IPV4.test(text);
}

/**
 * The sixteen bytes of RFC 3986's IPv6address, without a zone: eight groups of one to four
 * hexadecimal digits, at most one `::` standing for one or more zero groups, and optionally an
 * IPv4 address in place of the last two groups. `undefined` where `text` is not one.
 */
function ipv6Groups(text: string): number[] | undefined {
  const halves = text.split("::");
  if (halves.length > 2) {
    return undefined;
  }
  const groupsOf = (half: string, last: boolean): number[] | undefined => {
    if (half === "") {
      return [];
    }
    const parts = half.split(":");
    const out: number[] = [];
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i] as string;
      if (last && i === parts.length - 1 && part.includes(".")) {
        if (!isIpv4(part)) {
          return undefined;
        }
        const [a, b, c, d] = part.split(".").map(Number) as [number, number, number, number];
        out.push((a << 8) | b, (c << 8) | d);
      } else if (/^[0-9A-Fa-f]{1,4}$/.test(part)) {
        out.push(Number.parseInt(part, 16));
      } else {
        return undefined;
      }
    }
    return out;
  };
  if (halves.length === 1) {
    const groups = groupsOf(text, true);
    return groups !== undefined && groups.length === 8 ? groups : undefined;
  }
  const head = groupsOf(halves[0] as string, false);
  const tail = groupsOf(halves[1] as string, true);
  if (head === undefined || tail === undefined || head.length + tail.length > 7) {
    return undefined;
  }
  return [...head, ...new Array<number>(8 - head.length - tail.length).fill(0), ...tail];
}

/**
 * Whether `text` is an IPv6 address as the `ipv6` operation reads one: RFC 3986's IPv6address,
 * optionally followed by `%` and a zone ID (non-empty, without `%` or U+0000) where the address is
 * link-local unicast (fe80::/10) or multicast with a scope from 1 to D.
 */
export function isIpv6(text: string): boolean {
  const percent = text.indexOf("%");
  const address = percent < 0 ? text : text.slice(0, percent);
  const groups = ipv6Groups(address);
  if (groups === undefined) {
    return false;
  }
  if (percent < 0) {
    return true;
  }
  const zone = text.slice(percent + 1);
  if (zone === "" || zone.includes("%") || zone.includes("\u0000")) {
    return false;
  }
  const first = groups[0] as number;
  const linkLocal = (first & 0xffc0) === 0xfe80;
  const scope = first & 0x000f;
  const multicast = (first & 0xff00) === 0xff00 && scope >= 0x1 && scope <= 0xd;
  return linkLocal || multicast;
}

const ULID = /^[0-7][0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{25}$/;

/** Whether `text` is a ULID in its canonical text form, of at most 128 bits. */
export function isUlid(text: string): boolean {
  return ULID.test(text);
}

const CUID = /^c[a-z0-9]{24}$/;

/** Whether `text` is a CUID of version 1. */
export function isCuid(text: string): boolean {
  return CUID.test(text);
}

const UUID = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

/** Whether `text` is a UUID's 32 hexadecimal digits grouped 8-4-4-4-12, in either case. */
export function isUuid(text: string): boolean {
  return UUID.test(text);
}

const UNRESERVED = "A-Za-z0-9\\-._~";
const SUB_DELIMS = "!$&'()*+,;=";
const PCT_ENCODED = "%[0-9A-Fa-f]{2}";
const PCHAR = `(?:[${UNRESERVED}${SUB_DELIMS}:@]|${PCT_ENCODED})`;
const SCHEME = /^[A-Za-z][A-Za-z0-9+\-.]*$/;
const USERINFO = new RegExp(`^(?:[${UNRESERVED}${SUB_DELIMS}:]|${PCT_ENCODED})*$`);
const REG_NAME = new RegExp(`^(?:[${UNRESERVED}${SUB_DELIMS}]|${PCT_ENCODED})*$`);
const IPV_FUTURE = new RegExp(`^[vV][0-9A-Fa-f]+\\.[${UNRESERVED}${SUB_DELIMS}:]+$`);
const PORT = /^[0-9]*$/;
const PATH_ABEMPTY = new RegExp(`^(?:/${PCHAR}*)*$`);
const PATH_ABSOLUTE = new RegExp(`^/(?:${PCHAR}+(?:/${PCHAR}*)*)?$`);
const PATH_ROOTLESS = new RegExp(`^${PCHAR}+(?:/${PCHAR}*)*$`);
const QUERY = new RegExp(`^(?:${PCHAR}|[/?])*$`);

/** The parts of a URI the `url` operation asks about. */
export interface UriParts {
  readonly scheme: string;
  /** The host, where the URI has an authority. */
  readonly host: string | undefined;
}

/**
 * The scheme and host of `text` where it is a URI as the URI production of RFC 3986 section 3
 * derives it, and `undefined` where it is not: a relative reference is not one, and neither is an
 * IPv6 host with a zone identifier.
 */
export function uriParts(text: string): UriParts | undefined {
  const colon = text.indexOf(":");
  if (colon < 0) {
    return undefined;
  }
  const scheme = text.slice(0, colon);
  if (!SCHEME.test(scheme)) {
    return undefined;
  }
  let rest = text.slice(colon + 1);
  const hash = rest.indexOf("#");
  if (hash >= 0) {
    if (!QUERY.test(rest.slice(hash + 1))) {
      return undefined;
    }
    rest = rest.slice(0, hash);
  }
  const question = rest.indexOf("?");
  if (question >= 0) {
    if (!QUERY.test(rest.slice(question + 1))) {
      return undefined;
    }
    rest = rest.slice(0, question);
  }
  if (!rest.startsWith("//")) {
    const path = rest === "" || PATH_ABSOLUTE.test(rest) || PATH_ROOTLESS.test(rest);
    return path ? { scheme, host: undefined } : undefined;
  }
  const afterSlashes = rest.slice(2);
  const slash = afterSlashes.indexOf("/");
  const authority = slash < 0 ? afterSlashes : afterSlashes.slice(0, slash);
  const path = slash < 0 ? "" : afterSlashes.slice(slash);
  if (!PATH_ABEMPTY.test(path)) {
    return undefined;
  }
  const host = hostOf(authority);
  return host === undefined ? undefined : { scheme, host };
}

/** The host of an authority, `[ userinfo "@" ] host [ ":" port ]`, or `undefined` where it is not one. */
function hostOf(authority: string): string | undefined {
  const at = authority.indexOf("@");
  if (at >= 0 && !USERINFO.test(authority.slice(0, at))) {
    return undefined;
  }
  const hostAndPort = at >= 0 ? authority.slice(at + 1) : authority;
  let host: string;
  let port: string;
  if (hostAndPort.startsWith("[")) {
    const close = hostAndPort.indexOf("]");
    if (close < 0) {
      return undefined;
    }
    host = hostAndPort.slice(0, close + 1);
    const after = hostAndPort.slice(close + 1);
    if (after !== "" && !after.startsWith(":")) {
      return undefined;
    }
    port = after.slice(1);
    const literal = host.slice(1, -1);
    if (ipv6Groups(literal) === undefined && !IPV_FUTURE.test(literal)) {
      return undefined;
    }
  } else {
    const colon = hostAndPort.indexOf(":");
    host = colon < 0 ? hostAndPort : hostAndPort.slice(0, colon);
    port = colon < 0 ? "" : hostAndPort.slice(colon + 1);
    if (!REG_NAME.test(host)) {
      return undefined;
    }
  }
  return PORT.test(port) ? host : undefined;
}
