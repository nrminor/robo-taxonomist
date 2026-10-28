import { Cache, Context, Duration, Effect, Exit, Layer, Schema } from "effect";
import { RecordLabel, TaxonName, TaxonSet, Taxonomy } from "robo-taxonomist";
import { PanelId, panels, records } from "../lib/catalog.ts";
import { ClassificationFailure, MatchJudgment, PanelResponse } from "../lib/contract.ts";
import { publicModelFailure } from "../lib/failures.ts";
import { FixtureModel } from "./fixture-model.ts";

const inputs = records.map((record) =>
  record.kind === "vague"
    ? { id: record.id, abundance: record.abundance, label: RecordLabel.make(record.name) }
    : { id: record.id, abundance: record.abundance, scientificName: TaxonName.make(record.name) },
);

const lookup = Effect.fn("PanelResults.lookup")(function* (panelId: PanelId) {
  const panel = panels.find((entry) => entry.id === panelId);
  if (panel === undefined)
    return yield* Effect.fail(ClassificationFailure.cases.InvalidPanel.make({}));
  const taxonSet = panel.targets.reduce(
    (set, target) => TaxonSet.union(set, TaxonSet.of(TaxonName.make(target.name))),
    TaxonSet.empty(),
  );
  const result = yield* Taxonomy.classifyRecords(inputs, taxonSet).pipe(
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

export class PanelResults extends Context.Service<
  PanelResults,
  {
    readonly classify: (panelId: PanelId) => Effect.Effect<PanelResponse, ClassificationFailure>;
  }
>()("@robo-taxonomist/demo/PanelResults") {
  static readonly layerNoDeps = Layer.effect(
    PanelResults,
    Effect.gen(function* () {
      const cache = yield* Cache.makeWith(lookup, {
        capacity: 3,
        timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero),
      });
      return PanelResults.of({ classify: (panelId) => Cache.get(cache, panelId) });
    }),
  );
  static readonly layer = PanelResults.layerNoDeps.pipe(Layer.provide(FixtureModel));
}

export const classifyPanel = Effect.fn("classifyPanel")(function* (panelId: PanelId) {
  return yield* (yield* PanelResults).classify(panelId);
});
