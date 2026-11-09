import { Schema } from "effect";

const jsonText = Schema.fromJsonString(Schema.Unknown);

/** Encodes JSON with typed Effect failures; this does not validate a domain schema. */
export const encode = Schema.encodeEffect(jsonText);
/** Decodes JSON syntax with typed Effect failures, not domain validation. */
export const decode = Schema.decodeEffect(jsonText);
/** Encodes JSON synchronously, throwing on failure; this does not validate a domain schema. */
export const encodeSync = Schema.encodeSync(jsonText);
/** Decodes JSON syntax synchronously, throwing on failure, without domain validation. */
export const decodeSync = Schema.decodeSync(jsonText);
