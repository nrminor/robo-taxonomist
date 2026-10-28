import { Schema } from "effect";
import { AiError } from "effect/ai";
import { PanelId, panels, records } from "./catalog.ts";

const probability = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }));
export const MatchJudgment = Schema.TaggedUnion({ Matched: {}, NotMatched: {}, Undetermined: {} });
export type MatchJudgment = typeof MatchJudgment.Type;
export const PanelResponse = Schema.Struct({
  panelId: PanelId,
  rows: Schema.Array(
    Schema.Struct({
      recordId: Schema.String,
      matches: Schema.Array(
        Schema.Struct({
          targetId: Schema.String,
          judgment: MatchJudgment,
          support: probability,
          answer: Schema.Struct({
            confidence: Schema.optional(probability),
            label: Schema.Literals(["sameTaxon", "withinTaxon", "noMatch", "undetermined"]),
            probabilities: Schema.Struct({
              sameTaxon: probability,
              withinTaxon: probability,
              noMatch: probability,
              undetermined: probability,
            }),
          }),
        }),
      ),
    }),
  ),
}).check(
  Schema.makeFilter((response) => {
    const panel = panels.find((entry) => entry.id === response.panelId);
    return (
      (panel !== undefined &&
        response.rows.length === records.length &&
        response.rows.every(
          (row, index) =>
            row.recordId === records[index]?.id &&
            row.matches.length === panel.targets.length &&
            row.matches.every(
              (match, targetIndex) => match.targetId === panel.targets[targetIndex]?.id,
            ),
        )) ||
      "The reply must contain every record and panel target in the supplied order."
    );
  }),
);
export type PanelResponse = typeof PanelResponse.Type;

export const PublicModelReason = Schema.TaggedUnion({
  RateLimitError: {
    retryAfterMs: Schema.optional(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
  },
  QuotaExhaustedError: { resetAt: Schema.optional(Schema.DateTimeUtc) },
  AuthenticationError: { kind: AiError.AuthenticationError.fields.kind },
  ContentPolicyError: {},
  InvalidRequestError: {},
  InternalProviderError: {},
  NetworkError: {},
  InvalidOutputError: {},
  StructuredOutputError: {},
  UnsupportedSchemaError: {},
  UnknownError: {},
  ToolNotFoundError: {},
  ToolParameterValidationError: {},
  InvalidToolResultError: {},
  ToolResultEncodingError: {},
  ToolConfigurationError: {},
  ToolkitRequiredError: {},
  InvalidUserInputError: {},
});
export type PublicModelReason = typeof PublicModelReason.Type;
export const ClassificationFailure = Schema.TaggedUnion({
  ModelFailure: {
    reason: PublicModelReason,
    retryable: Schema.Boolean,
    requestId: Schema.optional(Schema.String),
  },
  InvalidPanel: {},
  ConfigurationFailure: { requestId: Schema.optional(Schema.String) },
  InternalFailure: { requestId: Schema.optional(Schema.String) },
});
export type ClassificationFailure = typeof ClassificationFailure.Type;
export const ClassificationReply = Schema.toCodecJson(
  Schema.Result(PanelResponse, ClassificationFailure),
);
export const ClassifyRequest = Schema.Struct({ panelId: PanelId });
