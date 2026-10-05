// Dates, times of day, date-times, date-times with an offset, and instants (spec/value-model.md).
//
// Which text is one of these is decided by the grammar 199x-notation shares between Raoh and
// Souther, and the value is built from the fields its reading of the text gives, so the text is
// read once and by that grammar alone. A date, a date-time and an offset date-time hold the years
// from -999999999 to 999999999 in the fields they are written in; an instant holds the moments on
// the UTC time-line from the first second of year -1000000000 to the last of year 1000000000,
// counted in seconds a `number` does not hold exactly. That is beyond what JavaScript's `Date`
// holds, so the types are this library's own.
//
// Each is a value: two are the same where `equals` says so, which compares every part. `compare`
// is the chronology `before`, `after` and `between` compare by, which for an offset date-time is
// the instant alone, so `09:00Z` and `10:00+01:00` are different values and neither is before the
// other. `toString` and `toJSON` write the observation of spec/observation.md.

import {
  type TemporalDate,
  type TemporalTime,
  readDate,
  readDateTime,
  readInstant,
  readOffsetDateTime,
  readTime,
} from "@raoh/199x-notation";
import { ofThisCopy, tagOf } from "./copy.ts";

const SECONDS_PER_DAY = 86_400n;

/**
 * What a constructor here is handed by this module and by nobody else: a value is made from what
 * 199x-notation read of a text, which is within the ranges the types hold, and from nothing else.
 * Each constructor is private, so the types name no way of making one, and asks for this as well,
 * since a private constructor is still one plain JavaScript can call.
 */
const MADE: unique symbol = Symbol("made by @raoh/core");

function made(given: symbol, name: string): void {
  if (given !== MADE) {
    throw new TypeError(`a ${name} is read from text, by ${name}.parse or a decoder, and not made`);
  }
}

// What makes each value, which only this module calls: each class hands its own over in a static
// block, the one place outside a constructor that can call it.
let makeDate: (year: number, month: number, day: number) => LocalDate;
let makeTime: (hour: number, minute: number, second: number, nanosecond: number) => LocalTime;
let makeDateTime: (date: LocalDate, time: LocalTime) => LocalDateTime;
let makeOffsetDateTime: (dateTime: LocalDateTime, offsetSeconds: number) => OffsetDateTime;
let makeInstant: (epochSecond: bigint, nanosecond: number) => Instant;

function order<T>(a: T, b: T): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A day of the proleptic Gregorian calendar, from year -999999999 to 999999999. */
export class LocalDate {
  readonly year: number;
  /** From 1 to 12. */
  readonly month: number;
  /** From 1 to the month's last. */
  readonly day: number;

  static {
    makeDate = (year, month, day) => new LocalDate(MADE, year, month, day);
  }

  private constructor(given: typeof MADE, year: number, month: number, day: number) {
    made(given, "LocalDate");
    this.year = year;
    this.month = month;
    this.day = day;
  }

  /** The date `text` names, as `string().date()` reads it, or `undefined` where it names none. */
  static parse(text: string): LocalDate | undefined {
    const read = readDate(text);
    return "value" in read ? dateOf(read.value) : undefined;
  }

  get [Symbol.toStringTag](): string {
    return tagOf("LocalDate");
  }

  /** Whether `other` is the same date. */
  equals(other: unknown): boolean {
    return ofThisCopy(other, LocalDate, "LocalDate") && this.compare(other) === 0;
  }

  /** -1, 0 or 1 as this date is before, the same as or after `other`. */
  compare(other: LocalDate): number {
    if (!ofThisCopy(other, LocalDate, "LocalDate")) {
      throw new TypeError(`${String(other)} is not a date to compare with`);
    }
    return order(this.year, other.year) || order(this.month, other.month) || order(this.day, other.day);
  }

  /** `yyyy-mm-dd`: a year from 0 to 9999 in four digits, a negative one as `-` and at least four, a greater one as `+` and its digits. */
  toString(): string {
    return `${yearText(this.year)}-${two(this.month)}-${two(this.day)}`;
  }

  toJSON(): string {
    return this.toString();
  }
}

/** A time of day to the nanosecond. */
export class LocalTime {
  /** From 0 to 23. */
  readonly hour: number;
  /** From 0 to 59. */
  readonly minute: number;
  /** From 0 to 59. */
  readonly second: number;
  /** From 0 to 999999999. */
  readonly nanosecond: number;

  static {
    makeTime = (hour, minute, second, nanosecond) => new LocalTime(MADE, hour, minute, second, nanosecond);
  }

  private constructor(given: typeof MADE, hour: number, minute: number, second: number, nanosecond: number) {
    made(given, "LocalTime");
    this.hour = hour;
    this.minute = minute;
    this.second = second;
    this.nanosecond = nanosecond;
  }

  /** The time `text` names, as `string().time()` reads it, or `undefined` where it names none. */
  static parse(text: string): LocalTime | undefined {
    const read = readTime(text);
    return "value" in read ? timeOf(read.value) : undefined;
  }

  get [Symbol.toStringTag](): string {
    return tagOf("LocalTime");
  }

  equals(other: unknown): boolean {
    return ofThisCopy(other, LocalTime, "LocalTime") && this.compare(other) === 0;
  }

  compare(other: LocalTime): number {
    if (!ofThisCopy(other, LocalTime, "LocalTime")) {
      throw new TypeError(`${String(other)} is not a time to compare with`);
    }
    return order(this.hour, other.hour) || order(this.minute, other.minute) || order(this.second, other.second)
      || order(this.nanosecond, other.nanosecond);
  }

  /** `hh:mm`, then `:ss` where the seconds or the fraction are not zero, then the fraction in three, six or nine digits where it is not zero. */
  toString(): string {
    const written = `${two(this.hour)}:${two(this.minute)}`;
    return this.second === 0 && this.nanosecond === 0 ? written : `${written}:${two(this.second)}${fraction(this.nanosecond)}`;
  }

  toJSON(): string {
    return this.toString();
  }
}

/** A date and a time of day, with no offset. */
export class LocalDateTime {
  readonly date: LocalDate;
  readonly time: LocalTime;

  static {
    makeDateTime = (date, time) => new LocalDateTime(MADE, date, time);
  }

  private constructor(given: typeof MADE, date: LocalDate, time: LocalTime) {
    made(given, "LocalDateTime");
    this.date = date;
    this.time = time;
  }

  /** The date-time `text` names, as `string().dateTime()` reads it, or `undefined` where it names none. */
  static parse(text: string): LocalDateTime | undefined {
    const read = readDateTime(text);
    return "value" in read ? dateTimeOf(read.value) : undefined;
  }

  get [Symbol.toStringTag](): string {
    return tagOf("LocalDateTime");
  }

  equals(other: unknown): boolean {
    return ofThisCopy(other, LocalDateTime, "LocalDateTime") && this.compare(other) === 0;
  }

  compare(other: LocalDateTime): number {
    if (!ofThisCopy(other, LocalDateTime, "LocalDateTime")) {
      throw new TypeError(`${String(other)} is not a date-time to compare with`);
    }
    return this.date.compare(other.date) || this.time.compare(other.time);
  }

  /** The date, `T`, the time. */
  toString(): string {
    return `${this.date.toString()}T${this.time.toString()}`;
  }

  toJSON(): string {
    return this.toString();
  }
}

/**
 * A date-time and an offset from UTC. Two at different offsets are different values even where they
 * name the same instant; `compare` compares the instants alone.
 */
export class OffsetDateTime {
  /** The date and time of day as written, not moved by the offset. */
  readonly dateTime: LocalDateTime;
  /** Seconds east of UTC, from -64800 to 64800. */
  readonly offsetSeconds: number;

  static {
    makeOffsetDateTime = (dateTime, offsetSeconds) => new OffsetDateTime(MADE, dateTime, offsetSeconds);
  }

  private constructor(given: typeof MADE, dateTime: LocalDateTime, offsetSeconds: number) {
    made(given, "OffsetDateTime");
    this.dateTime = dateTime;
    this.offsetSeconds = offsetSeconds;
  }

  /** The offset date-time `text` names, as `string().offsetDateTime()` reads it, or `undefined` where it names none. */
  static parse(text: string): OffsetDateTime | undefined {
    const read = readOffsetDateTime(text);
    return "value" in read ? makeOffsetDateTime(dateTimeOf(read.value.dateTime), read.value.offsetSeconds) : undefined;
  }

  get [Symbol.toStringTag](): string {
    return tagOf("OffsetDateTime");
  }

  /** Whether `other` is the same date-time at the same offset. */
  equals(other: unknown): boolean {
    return ofThisCopy(other, OffsetDateTime, "OffsetDateTime") && this.dateTime.equals(other.dateTime)
      && this.offsetSeconds === other.offsetSeconds;
  }

  /** -1, 0 or 1 as the instant this names is before, the same as or after the one `other` names. */
  compare(other: OffsetDateTime): number {
    if (!ofThisCopy(other, OffsetDateTime, "OffsetDateTime")) {
      throw new TypeError(`${String(other)} is not an offset date-time to compare with`);
    }
    return order(this.#epochSecond(), other.#epochSecond())
      || order(this.dateTime.time.nanosecond, other.dateTime.time.nanosecond);
  }

  #epochSecond(): bigint {
    const { date, time } = this.dateTime;
    return daysFromCivil(BigInt(date.year), date.month, date.day) * SECONDS_PER_DAY
      + BigInt(time.hour * 3600 + time.minute * 60 + time.second - this.offsetSeconds);
  }

  /** The date-time, then `Z` for the zero offset and otherwise `±hh:mm`, then `:ss` where the offset's seconds are not zero. */
  toString(): string {
    if (this.offsetSeconds === 0) {
      return `${this.dateTime.toString()}Z`;
    }
    const total = Math.abs(this.offsetSeconds);
    const seconds = total % 60;
    return `${this.dateTime.toString()}${this.offsetSeconds < 0 ? "-" : "+"}${two(Math.floor(total / 3600))}:${two(Math.floor(total / 60) % 60)}${seconds === 0 ? "" : `:${two(seconds)}`}`;
  }

  toJSON(): string {
    return this.toString();
  }
}

/**
 * A point on the UTC time-line to the nanosecond, counted from 1970-01-01T00:00:00Z: from the first
 * second of year -1000000000 to the last of year 1000000000, a year further on either side than a
 * date holds, since an offset and an hour 24 move a moment across the end of a year.
 */
export class Instant {
  /** Seconds from 1970-01-01T00:00:00Z to the second at or before the instant. */
  readonly epochSecond: bigint;
  /** Nanoseconds from that second, from 0 to 999999999. */
  readonly nanosecond: number;

  static {
    makeInstant = (epochSecond, nanosecond) => new Instant(MADE, epochSecond, nanosecond);
  }

  private constructor(given: typeof MADE, epochSecond: bigint, nanosecond: number) {
    made(given, "Instant");
    this.epochSecond = epochSecond;
    this.nanosecond = nanosecond;
  }

  /** The instant `text` names, as `string().iso8601()` reads it, or `undefined` where it names none. */
  static parse(text: string): Instant | undefined {
    const read = readInstant(text);
    return "value" in read ? makeInstant(read.value.epochSecond, read.value.nanosecond) : undefined;
  }

  get [Symbol.toStringTag](): string {
    return tagOf("Instant");
  }

  equals(other: unknown): boolean {
    return ofThisCopy(other, Instant, "Instant") && this.compare(other) === 0;
  }

  compare(other: Instant): number {
    if (!ofThisCopy(other, Instant, "Instant")) {
      throw new TypeError(`${String(other)} is not an instant to compare with`);
    }
    return order(this.epochSecond, other.epochSecond) || order(this.nanosecond, other.nanosecond);
  }

  /** The date and time in UTC, the seconds always written, then `Z`. */
  toString(): string {
    const days = floorDiv(this.epochSecond, SECONDS_PER_DAY);
    const ofDay = Number(this.epochSecond - days * SECONDS_PER_DAY);
    const [year, month, day] = civilFromDays(days);
    return `${yearText(year)}-${two(month)}-${two(day)}T${two(Math.floor(ofDay / 3600))}:${two(Math.floor(ofDay / 60) % 60)}:${two(ofDay % 60)}${fraction(this.nanosecond)}Z`;
  }

  toJSON(): string {
    return this.toString();
  }
}

/** A temporal value, as the operations that compare them take one. */
export type Temporal = LocalDate | LocalTime | LocalDateTime | OffsetDateTime | Instant;

function dateOf(read: TemporalDate): LocalDate {
  return makeDate(read.year, read.month, read.day);
}

/** A fraction written as `.000` and none are the same time of day. */
function timeOf(read: TemporalTime): LocalTime {
  return makeTime(read.hour, read.minute, read.second, read.nanosecond ?? 0);
}

function dateTimeOf(read: { readonly date: TemporalDate; readonly time: TemporalTime }): LocalDateTime {
  return makeDateTime(dateOf(read.date), timeOf(read.time));
}

function two(n: number): string {
  return String(n).padStart(2, "0");
}

function yearText(year: number | bigint): string {
  const n = BigInt(year);
  if (n >= 0n && n <= 9999n) {
    return String(n).padStart(4, "0");
  }
  return n < 0n ? `-${String(-n).padStart(4, "0")}` : `+${n}`;
}

/** The fraction of a second in three, six or nine digits, with its point, or nothing where it is zero. */
function fraction(nanosecond: number): string {
  if (nanosecond === 0) {
    return "";
  }
  if (nanosecond % 1_000_000 === 0) {
    return `.${String(nanosecond / 1_000_000).padStart(3, "0")}`;
  }
  if (nanosecond % 1_000 === 0) {
    return `.${String(nanosecond / 1_000).padStart(6, "0")}`;
  }
  return `.${String(nanosecond).padStart(9, "0")}`;
}

function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a % b !== 0n && (a < 0n) !== (b < 0n) ? q - 1n : q;
}

/** Days from 1970-01-01 to the date, by Howard Hinnant's `days_from_civil`. */
function daysFromCivil(year: bigint, month: number, day: number): bigint {
  const y = month <= 2 ? year - 1n : year;
  const era = floorDiv(y, 400n);
  const yearOfEra = y - era * 400n;
  const dayOfYear = BigInt(Math.floor((153 * (month > 2 ? month - 3 : month + 9) + 2) / 5) + day - 1);
  const dayOfEra = yearOfEra * 365n + yearOfEra / 4n - yearOfEra / 100n + dayOfYear;
  return era * 146_097n + dayOfEra - 719_468n;
}

/** The date `days` after 1970-01-01, by Howard Hinnant's `civil_from_days`. */
function civilFromDays(days: bigint): [bigint, number, number] {
  const shifted = days + 719_468n;
  const era = floorDiv(shifted, 146_097n);
  const dayOfEra = shifted - era * 146_097n;
  const yearOfEra = (dayOfEra - dayOfEra / 1460n + dayOfEra / 36_524n - dayOfEra / 146_096n) / 365n;
  const dayOfYear = dayOfEra - (365n * yearOfEra + yearOfEra / 4n - yearOfEra / 100n);
  const mp = (5n * dayOfYear + 2n) / 153n;
  const day = Number(dayOfYear - (153n * mp + 2n) / 5n + 1n);
  const month = Number(mp < 10n ? mp + 3n : mp - 9n);
  return [yearOfEra + era * 400n + (month <= 2 ? 1n : 0n), month, day];
}
