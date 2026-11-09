import { Schema } from "effect";

const jsonText = Schema.fromJsonString(Schema.Unknown);

/** Serializes test values as JSON with typed failures and no domain validation. */
export const encode = Schema.encodeEffect(jsonText);

/** Serializes test values as JSON without domain validation, throwing on failure. */
export const encodeSync = Schema.encodeSync(jsonText);

/** Parses JSON text without domain validation, throwing on failure. */
export const decodeSync = Schema.decodeSync(jsonText);
