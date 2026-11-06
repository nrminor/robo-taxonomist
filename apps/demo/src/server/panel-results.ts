import { Array, Cache, Context, Duration, Effect, Exit, Layer, Schema } from "effect";
import {
  CollectionExecution,
  RecordLabel,
  TaxonName,
  TaxonSet,
  Taxonomy,
  TaxonomyHint,
} from "robo-taxonomist";
import { PanelId, panels, records } from "../lib/catalog.ts";
import * as Contract from "../lib/contract.ts";
import { FixtureModel } from "./fixture-model.ts";

const inputs = records.map((record) =>
  record.kind === "vague"
    ? { id: record.id, abundance: record.abundance, label: RecordLabel.make(record.name) }
    : { id: record.id, abundance: record.abundance, scientificName: TaxonName.make(record.name) },
);

const execution = CollectionExecution.make({ batchSize: 6, concurrency: 1 });

const lookup = Effect.fn("PanelResults.lookup")(function* ({
  panelId,
  hints,
}: {
  readonly panelId: PanelId;
  readonly hints: ReadonlyArray<TaxonomyHint>;
}) {
  const panel = panels.find((entry) => entry.id === panelId);
  if (panel === undefined)
    return yield* Effect.fail(Contract.ClassificationFailure.cases.InvalidPanel.make({}));
  const taxonSet = panel.targets.reduce<TaxonSet.TaxonSet<{ readonly scientificName: TaxonName }>>(
    (set, target) => TaxonSet.union(set, TaxonSet.of(TaxonName.make(target.name))),
    TaxonSet.empty(),
  );
  const result = yield* Taxonomy.classifyRecords(inputs, taxonSet, { execution, hints });
  return yield* Schema.decodeUnknownEffect(Contract.PanelResponse)({
    panelId,
    rows: result.records.map((row) => ({
      recordId: row.record.id,
      matches: row.taxa.map((match, index) => ({
        targetId: panel.targets[index]?.id,
        judgment: match.judgment,
        answer: match.answer,
      })),
    })),
  });
});

type LookupFailure = Effect.Error<ReturnType<typeof lookup>>;

/**
 * Cache successful, schema-validated results by panel and ordered hints per layer instance.
 * Native refresh keeps an old success readable while running; failed refreshes evict only that entry.
 * Failed lookups expire immediately; collection execution uses batch size six and concurrency one.
 */
export class PanelResults extends Context.Service<
  PanelResults,
  {
    readonly classify: (
      panelId: PanelId,
      refresh?: boolean,
      hints?: ReadonlyArray<TaxonomyHint>,
    ) => Effect.Effect<Contract.PanelResponse, LookupFailure>;
  }
>()("@robo-taxonomist/demo/PanelResults") {
  /** Build the cache using the caller-supplied decision model, including live adapters. */
  static readonly layerNoDeps = Layer.effect(
    PanelResults,
    Effect.gen(function* () {
      const cache = yield* Cache.makeWith(lookup, {
        capacity: 3,
        timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero),
      });
      return PanelResults.of({
        classify: (panelId, refresh = false, hints = []) => {
          const key = { panelId, hints: Array.copy(hints) };
          return refresh ? Cache.refresh(cache, key) : Cache.get(cache, key);
        },
      });
    }),
  );
  /** Self-contained teaching-fixture layer; does not make provider requests. */
  static readonly layer = PanelResults.layerNoDeps.pipe(Layer.provide(FixtureModel));
}

/** Classify through PanelResults; refresh forces a fresh lookup for the selected panel and hints. */
export const classifyPanel = Effect.fn("classifyPanel")(function* (
  panelId: PanelId,
  refresh = false,
  hints?: ReadonlyArray<TaxonomyHint>,
) {
  const results = yield* PanelResults;
  return yield* results.classify(panelId, refresh, hints);
});
