import { TypeSafeClient, TypeSafeDecisionModel } from "@effect/ai-typesafe";
import { Config, Layer, Schema } from "effect";
import { DecisionModel, type AiError } from "effect/ai";
import { CliError, Flag } from "effect/cli";

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

/** Turn a provider failure into a CLI diagnostic without exposing provider details. */
export const modelFailure = (cause: AiError.AiError) =>
  new CliError.UserError({
    cause,
    userMessage:
      "The decision model request failed; check credentials, selected model and provider availability",
  });
