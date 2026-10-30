import { Schema } from "effect";
import { AiError } from "effect/ai";
import { PanelId, panels, records } from "./catalog.ts";

const probability = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }));
export const MatchJudgment = Schema.TaggedUnion({ Matched: {}, NotMatched: {}, Undetermined: {} });
export type MatchJudgment = typeof MatchJudgment.Type;
const Match = Schema.Struct({
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
});

const matchFor = (targetId: string) =>
  Schema.Struct({ ...Match.fields, targetId: Schema.Literal(targetId) });

export type PanelResponse = {
  readonly panelId: PanelId;
  readonly rows: ReadonlyArray<{
    readonly recordId: string;
    readonly matches: ReadonlyArray<typeof Match.Type>;
  }>;
};

// Effect's Tuple type recursion infers [] for mapped arrays. Expose the domain
// array shape explicitly; generated literals/tuples enforce order and length.
export const PanelResponse: Schema.Codec<PanelResponse> = Schema.Union(
  panels.map((panel) =>
    Schema.Struct({
      panelId: Schema.Literal(panel.id),
      rows: Schema.Tuple(
        records.map((record) =>
          Schema.Struct({
            recordId: Schema.Literal(record.id),
            matches: Schema.Tuple(panel.targets.map((target) => matchFor(target.id))),
          }),
        ),
      ),
    }),
  ),
);

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
