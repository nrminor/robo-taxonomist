import { Cache, Context, Duration, Effect, Exit, Layer, Schema } from "effect";
import { CollectionExecution, RecordLabel, TaxonName, TaxonSet, Taxonomy } from "robo-taxonomist";
import { PanelId, panels, records } from "../lib/catalog.ts";
import { ClassificationFailure, MatchJudgment, PanelResponse } from "../lib/contract.ts";
import { publicModelFailure } from "../lib/failures.ts";
import { FixtureModel } from "./fixture-model.ts";

const inputs = records.map((record) =>
  record.kind === "vague"
    ? { id: record.id, abundance: record.abundance, label: RecordLabel.make(record.name) }
    : { id: record.id, abundance: record.abundance, scientificName: TaxonName.make(record.name) },
);

const execution = CollectionExecution.make({ batchSize: 6, concurrency: 1 });

const lookup = Effect.fn("PanelResults.lookup")(function* (panelId: PanelId) {
  const panel = panels.find((entry) => entry.id === panelId);
  if (panel === undefined)
    return yield* Effect.fail(ClassificationFailure.cases.InvalidPanel.make({}));
  const taxonSet = panel.targets.reduce<TaxonSet.TaxonSet<{ readonly scientificName: TaxonName }>>(
    (set, target) => TaxonSet.union(set, TaxonSet.of(TaxonName.make(target.name))),
    TaxonSet.empty(),
  );
  const result = yield* Taxonomy.classifyRecords(inputs, taxonSet, { execution }).pipe(
    Effect.mapError(publicModelFailure),
  );
  return yield* Schema.decodeUnknownEffect(PanelResponse)({
    panelId,
    rows: result.records.map((row) => ({
      recordId: row.record.id,
      matches: row.taxa.map((match, index) => ({
        targetId: panel.targets[index]?.id,
        judgment: MatchJudgment.match(match.judgment, {
          Matched: (): MatchJudgment => MatchJudgment.cases.Matched.make({}),
          NotMatched: (): MatchJudgment => MatchJudgment.cases.NotMatched.make({}),
          Undetermined: (): MatchJudgment => MatchJudgment.cases.Undetermined.make({}),
        }),
        support: match.support,
        answer: match.answer,
      })),
    })),
  }).pipe(Effect.mapError(() => ClassificationFailure.cases.InternalFailure.make({})));
});

/**
 * Panel classification service caching successful, schema-validated results indefinitely per layer instance.
 * Native refresh keeps an old success readable while running; failed refreshes evict only that entry.
 * Failed lookups expire immediately; collection execution uses batch size six and concurrency one.
 */
export class PanelResults extends Context.Service<
  PanelResults,
  {
    readonly classify: (
      panelId: PanelId,
      refresh?: boolean,
    ) => Effect.Effect<PanelResponse, ClassificationFailure>;
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
        classify: (panelId, refresh = false) =>
          refresh ? Cache.refresh(cache, panelId) : Cache.get(cache, panelId),
      });
    }),
  );
  /** Self-contained teaching-fixture layer; does not make provider requests. */
  static readonly layer = PanelResults.layerNoDeps.pipe(Layer.provide(FixtureModel));
}

/** Classify through PanelResults; refresh forces a fresh lookup without touching other panels. */
export const classifyPanel = Effect.fn("classifyPanel")(function* (
  panelId: PanelId,
  refresh = false,
) {
  const results = yield* PanelResults;
  return yield* results.classify(panelId, refresh);
});
