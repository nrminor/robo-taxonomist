import { TypeSafeClient, TypeSafeDecisionModel } from "@effect/ai-typesafe";
import { Config, Layer, Match, Schema } from "effect";
import { DecisionModel, type AiError } from "effect/ai";
import { CliError, Flag } from "effect/cli";
import { type Errors } from "robo-taxonomist";

const modelName = Schema.String.check(
  Schema.isPattern(/\S/u, { expected: "nonblank model identifier" }),
);

/** Select the model from --model or ROBO_TAXONOMIST_MODEL. */
export const modelFlag = Flag.String("model").pipe(
  Flag.withSchema(modelName),
  Flag.withFallbackConfig(Config.schema(modelName, "ROBO_TAXONOMIST_MODEL")),
  Flag.withDescription(
    "Override ROBO_TAXONOMIST_MODEL for this command. Set TYPESAFE_API_KEY in the environment.",
  ),
);

/** Provide the selected TypeSafe model with credentials read from the environment. */
export const modelLayer = (model: string) =>
  TypeSafeDecisionModel.layer({ model }).pipe(
    Layer.provide(TypeSafeClient.layerConfig()),
    Layer.catch((cause) =>
      Layer.effect(
        DecisionModel.DecisionModel,
        new CliError.UserError({
          cause,
          userMessage:
            "TypeSafe configuration is missing or invalid; set TYPESAFE_API_KEY in the environment",
        }),
      ),
    ),
  );

const unusableAnswer = "The decision model returned an unusable answer; check the selected model";

const modelMessage = (error: AiError.AiError) =>
  Match.value(error.reason).pipe(
    Match.tag(
      "AuthenticationError",
      () => "The model provider rejected authentication; check TYPESAFE_API_KEY",
    ),
    Match.tag(
      "RateLimitError",
      () => "The model provider is rate-limiting requests; wait before trying again",
    ),
    Match.tag(
      "QuotaExhaustedError",
      () => "The model provider quota is exhausted; check your provider account",
    ),
    Match.tag(
      "NetworkError",
      () => "Cannot reach the model provider; check your network connection",
    ),
    Match.tag(
      "ContentPolicyError",
      () => "The model provider declined the request under its content policy",
    ),
    Match.tag(
      "InvalidUserInputError",
      () => "The taxonomic input could not be processed; check the supplied records and sets",
    ),
    Match.tag("InvalidOutputError", () => unusableAnswer),
    Match.tag("InvalidResponseError", () => unusableAnswer),
    Match.tag("StructuredOutputError", () => unusableAnswer),
    Match.orElse(
      () => "The decision model request failed; check the selected model and provider availability",
    ),
  );

/** Translate taxonomy failures once while retaining their causes for inspection. */
export const cliFailure = (error: Errors.TaxonomyError | CliError.UserError) =>
  Match.value(error).pipe(
    Match.tagsExhaustive({
      InvalidInput: (cause) =>
        new CliError.UserError({
          cause,
          userMessage: "Check the supplied taxonomic identifying fields",
        }),
      AiError: (cause) => new CliError.UserError({ cause, userMessage: modelMessage(cause) }),
      UserError: (cause) => cause,
    }),
  );
