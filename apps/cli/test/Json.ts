import { Schema } from "effect";

const jsonText = Schema.fromJsonString(Schema.Unknown);

/** Encodes JSON without domain validation, returning typed failures. */
export const encode = Schema.encodeEffect(jsonText);

/** Decodes JSON without domain validation, returning typed failures. */
export const decode = Schema.decodeEffect(jsonText);
