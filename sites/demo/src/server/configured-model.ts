import "server-only";
import { Config, Effect, Layer, Schema } from "effect";
import { ClassificationFailure } from "../lib/contract.ts";
import { clefModelLayer } from "./clef-model.ts";
import { PanelResults } from "./panel-results.ts";

const credentials = Config.all({
  accountId: Config.schema(
    Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/i)),
    "CLOUDFLARE_ACCOUNT_ID",
  ),
  apiToken: Config.schema(
    Schema.Redacted(Schema.String.check(Schema.isPattern(/^\S+$/))),
    "CLOUDFLARE_API_TOKEN",
  ),
});

export const ConfiguredPanelResults = Layer.unwrap(
  Effect.gen(function* () {
    const mode = yield* Config.Literals(["fixture", "clef"], "DEMO_MODEL").pipe(
      Config.withDefault("fixture"),
    );
    if (mode === "fixture") return PanelResults.layer;
    const config = yield* credentials;
    return PanelResults.layerNoDeps.pipe(Layer.provide(clefModelLayer(config)));
  }).pipe(Effect.mapError(() => ClassificationFailure.cases.ConfigurationFailure.make({}))),
);
