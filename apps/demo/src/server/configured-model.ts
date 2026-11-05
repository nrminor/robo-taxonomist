import "server-only";
import { Config, Effect, Layer, Match, Schema } from "effect";
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

/**
 * Select fixtures by default, or live Clef with DEMO_MODEL=clef and validated Cloudflare credentials.
 * Requires an HTTP client for live mode; configuration errors become public ConfigurationFailure values.
 */
export const ConfiguredPanelResults = Layer.unwrap(
  Effect.gen(function* () {
    const mode = yield* Config.Literals(["fixture", "clef"], "DEMO_MODEL").pipe(
      Config.withDefault("fixture"),
    );
    return yield* Match.value(mode).pipe(
      Match.literalsExhaustive({
        fixture: () => Effect.succeed(PanelResults.layer),
        clef: () =>
          credentials.pipe(
            Effect.map((config) =>
              PanelResults.layerNoDeps.pipe(Layer.provide(clefModelLayer(config))),
            ),
          ),
      }),
    );
  }).pipe(Effect.mapError(() => ClassificationFailure.cases.ConfigurationFailure.make({}))),
);
