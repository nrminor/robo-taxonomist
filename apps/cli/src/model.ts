import { TypeSafeClient, TypeSafeDecisionModel } from "@effect/ai-typesafe";
import { Config, Effect, Layer, Schema } from "effect";
import { DecisionModel, type AiError } from "effect/ai";
import { CliError, Flag } from "effect/cli";

const modelName = Schema.String.check(
  Schema.isPattern(/\S/u, { expected: "nonblank model identifier" }),
);

export const modelHelp =
  "Use --model to override ROBO_TAXONOMIST_MODEL. There is no implicit model default or application model allowlist.\n\n" +
  "Inject TYPESAFE_API_KEY through the environment, not a command-line argument. Model and client are acquired once for the selected command; help and pure operations need no credentials.\n\n" +
  "Negative and unresolved judgments succeed. Provider and output failures fail the invocation. TSV includes one header unless --no-header is supplied; --format json emits the complete native judgment.";

export const modelFlag = Flag.String("model").pipe(
  Flag.withSchema(modelName),
  Flag.withFallbackConfig(Config.schema(modelName, "ROBO_TAXONOMIST_MODEL")),
  Flag.withDescription("TypeSafe model identifier, or ROBO_TAXONOMIST_MODEL. No implicit default."),
);

export const modelLayer = (model: string) =>
  TypeSafeDecisionModel.layer({ model }).pipe(
    Layer.provide(TypeSafeClient.layerConfig()),
    Layer.catch((cause) =>
      Layer.effect(
        DecisionModel.DecisionModel,
        Effect.fail(
          new CliError.UserError({
            cause,
            userMessage:
              "TypeSafe configuration is missing or invalid; set TYPESAFE_API_KEY in the environment",
          }),
        ),
      ),
    ),
  );

export const modelFailure = (cause: AiError.AiError) =>
  new CliError.UserError({
    cause,
    userMessage:
      "The decision model request failed; check credentials, selected model and provider availability",
  });
