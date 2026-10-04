// Raoh for TypeScript: decoders that turn untyped boundary input into typed domain values.

export { Decimal } from "./decimal.ts";
export { Chain, Decoder, type Run, decoder, nullable, recover, recoverWith, withDefault } from "./decoder.ts";
export * as encode from "./encode.ts";
export { Float, type Width } from "./float.ts";
export { JsonNumber, type Kind, kindOf, parse } from "./input.ts";
export { Issue, type IssueInit, Issues, type Failed, type Ok, type Result, failed, ok } from "./issue.ts";
export { INVALID_FORMAT_JSON, type MessageResolver, Messages } from "./messages.ts";
export { messageForm, same } from "./meta.ts";
export { Path, type Segment } from "./path.ts";
export {
  BoolDecoder,
  BoundedDecoder,
  DecimalDecoder,
  DoubleDecoder,
  FloatDecoder,
  IntDecoder,
  LongDecoder,
  StringDecoder,
  bool,
  decimal,
  double,
  float,
  int,
  long,
  string,
} from "./scalars.ts";
export { ValueSet } from "./set.ts";
export { type IssueWire, issueWire, type Wire } from "./wire.ts";
export {
  ABSENT,
  DictDecoder,
  Field,
  ListDecoder,
  NULL,
  ObjectDecoder,
  type Presence,
  type ReadWith,
  dict,
  discriminate,
  discriminateBy,
  enumOf,
  field,
  flat,
  list,
  literal,
  object,
  oneOf,
  optionalField,
  optionalNullableField,
  presentWith,
  strict,
} from "./structure.ts";
