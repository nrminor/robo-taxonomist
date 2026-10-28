import { Cause, Duration, Match, Option, Schema } from "effect";
import { AiError } from "effect/ai";
import { ClassificationFailure, PublicModelReason } from "./contract.ts";

const publicReason = Match.type<AiError.AiErrorReason>().pipe(
  Match.tagsExhaustive({
    RateLimitError: (reason) => {
      const millis =
        reason.retryAfter === undefined ? undefined : Duration.toMillis(reason.retryAfter);
      return PublicModelReason.cases.RateLimitError.make(
        millis !== undefined && Number.isFinite(millis) && millis >= 0
          ? { retryAfterMs: millis }
          : {},
      );
    },
    QuotaExhaustedError: (reason) =>
      PublicModelReason.cases.QuotaExhaustedError.make(
        reason.resetAt === undefined ? {} : { resetAt: reason.resetAt },
      ),
    AuthenticationError: (reason) =>
      PublicModelReason.cases.AuthenticationError.make({ kind: reason.kind }),
    ContentPolicyError: () => PublicModelReason.cases.ContentPolicyError.make({}),
    InvalidRequestError: () => PublicModelReason.cases.InvalidRequestError.make({}),
    InternalProviderError: () => PublicModelReason.cases.InternalProviderError.make({}),
    NetworkError: () => PublicModelReason.cases.NetworkError.make({}),
    InvalidOutputError: () => PublicModelReason.cases.InvalidOutputError.make({}),
    StructuredOutputError: () => PublicModelReason.cases.StructuredOutputError.make({}),
    UnsupportedSchemaError: () => PublicModelReason.cases.UnsupportedSchemaError.make({}),
    UnknownError: () => PublicModelReason.cases.UnknownError.make({}),
    ToolNotFoundError: () => PublicModelReason.cases.ToolNotFoundError.make({}),
    ToolParameterValidationError: () =>
      PublicModelReason.cases.ToolParameterValidationError.make({}),
    InvalidToolResultError: () => PublicModelReason.cases.InvalidToolResultError.make({}),
    ToolResultEncodingError: () => PublicModelReason.cases.ToolResultEncodingError.make({}),
    ToolConfigurationError: () => PublicModelReason.cases.ToolConfigurationError.make({}),
    ToolkitRequiredError: () => PublicModelReason.cases.ToolkitRequiredError.make({}),
    InvalidUserInputError: () => PublicModelReason.cases.InvalidUserInputError.make({}),
  }),
);

export const publicModelFailure = (error: AiError.AiError): ClassificationFailure =>
  ClassificationFailure.cases.ModelFailure.make({
    reason: publicReason(error.reason),
    retryable: error.isRetryable,
  });

export const publicCauseFailure = (
  cause: Cause.Cause<unknown>,
): Option.Option<ClassificationFailure> => {
  if (Cause.hasDies(cause))
    return Option.some(ClassificationFailure.cases.InternalFailure.make({}));
  if (Cause.hasInterruptsOnly(cause)) return Option.none();
  const error = Cause.findErrorOption(cause);
  if (Option.isSome(error)) {
    if (AiError.isAiError(error.value)) return Option.some(publicModelFailure(error.value));
    if (Schema.is(ClassificationFailure)(error.value)) return Option.some(error.value);
  }
  return Option.some(ClassificationFailure.cases.InternalFailure.make({}));
};
