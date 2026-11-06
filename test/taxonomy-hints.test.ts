import { expect, it } from "@effect/vitest";
import { Array, Data, Deferred, Effect, Fiber, Layer, Record } from "effect";
import { DecisionModel } from "effect/ai";
import {
  CollectionExecution,
  RecordLabel,
  TaxonName,
  TaxonSet,
  Taxonomy,
  TaxonomyHints,
  taxonomyHintsLayer,
} from "../src/index.ts";

const { Classify } = Data.taggedEnum<DecisionModel.ProviderClassifyAnswer>();
const subject = RecordLabel.make("subject");
const target = TaxonSet.of(TaxonName.make("Fungi"));
const other = TaxonSet.of(TaxonName.make("Plants"));

it.effect("selects scoped, direct, empty and updated hints without leaking scopes", () => {
  const seen: unknown[] = [];
  const model = Layer.effect(
    DecisionModel.DecisionModel,
    DecisionModel.make({
      decide: ({ state }) => {
        seen.push(state);
        return Effect.succeed({
          answers: {
            r0t0: Classify({
              label: "undetermined",
              probabilities: { sameTaxon: 0, withinTaxon: 0, noMatch: 0, undetermined: 1 },
            }),
          },
          usage: { inputTokens: undefined, outputTokens: undefined },
        });
      },
    }),
  );
  const operation = Taxonomy.classifyRecords([subject], target);
  const source = ["outer"];
  const hintsLayer = taxonomyHintsLayer(source);
  source.push("later");
  return Effect.gen(function* () {
    yield* operation;
    yield* operation.pipe(Effect.provide(hintsLayer));
    yield* Taxonomy.classifyRecords([subject], target, { hints: ["direct"] }).pipe(
      Effect.provide(hintsLayer),
    );
    yield* Taxonomy.classifyRecords([subject], target, { hints: [] }).pipe(
      Effect.provide(hintsLayer),
    );
    yield* operation.pipe(
      Effect.updateService(TaxonomyHints, Array.append("inner")),
      Effect.provide(hintsLayer),
    );
    yield* operation.pipe(Effect.provide(hintsLayer));
    yield* Taxonomy.classifyRecords([subject], target, { hints: undefined }).pipe(
      Effect.provide(hintsLayer),
    );
    expect(seen[0]).toEqual(seen[3]);
    expect(seen[1]).toMatchObject({ hints: ["outer"] });
    expect(seen[2]).toMatchObject({ hints: ["direct"] });
    expect(seen[4]).toMatchObject({ hints: ["outer", "inner"] });
    expect(seen[5]).toEqual(seen[1]);
    expect(seen[6]).toEqual(seen[1]);
  }).pipe(Effect.provide(model));
});

it.effect("snapshots group hints before the first request for later targets", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const seen: unknown[] = [];
    const hints = ["initial"];
    const model = Layer.effect(
      DecisionModel.DecisionModel,
      DecisionModel.make({
        decide: Effect.fnUntraced(function* ({ state, decisions }) {
          seen.push(state);
          if (seen.length === 1) {
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(release);
          }
          return {
            answers: Record.map(decisions, () =>
              Classify({
                label: "undetermined",
                probabilities: {
                  member: 0,
                  notMember: 0,
                  mixed: 0,
                  undetermined: 1,
                  multipleTarget0: 0,
                },
              }),
            ),
            usage: { inputTokens: undefined, outputTokens: undefined },
          };
        }),
      }),
    );
    const fiber = yield* Taxonomy.groupRecordsByTaxa([subject], [target, other], { hints }).pipe(
      Effect.provide(model),
      Effect.forkChild,
    );
    yield* Deferred.await(started);
    hints.push("mutated");
    yield* Deferred.succeed(release, undefined);
    const result = yield* Fiber.join(fiber);
    expect(result.groups).toHaveLength(2);
    expect(seen).toHaveLength(2);
    for (const state of seen) expect(state).toMatchObject({ hints: ["initial"] });
  }),
);

it.effect("carries hints through successive quantifier windows", () => {
  const seen: unknown[] = [];
  const hints = ["prior"];
  const model = Layer.effect(
    DecisionModel.DecisionModel,
    DecisionModel.make({
      decide: ({ state, decisions }) => {
        seen.push(state);
        hints.push("mutated");
        return Effect.succeed({
          answers: Record.map(decisions, () =>
            Classify({
              label: "member",
              probabilities: {
                member: 1,
                notMember: 0,
                mixed: 0,
                undetermined: 0,
                multipleTarget0: 0,
              },
            }),
          ),
          usage: { inputTokens: undefined, outputTokens: undefined },
        });
      },
    }),
  );
  return Effect.gen(function* () {
    const result = yield* Taxonomy.allRecordsBelongTo([subject, subject], target, {
      hints,
      execution: CollectionExecution.make({ batchSize: 1, concurrency: 1 }),
    });
    expect(result._tag).toBe("Yes");
    expect(seen).toHaveLength(2);
    for (const state of seen) expect(state).toMatchObject({ hints: ["prior"] });
  }).pipe(Effect.provide(model));
});

it.effect("delivers hints across comparison, relation, membership and delegated operations", () => {
  const states: unknown[] = [];
  const instructions: unknown[] = [];
  const model = Layer.effect(
    DecisionModel.DecisionModel,
    DecisionModel.make({
      decide: ({ state, decisions }) => {
        states.push(state);
        const answers = Record.map(decisions, (decision) => {
          if (decision._tag !== "Classify") throw new Error("Expected classification");
          instructions.push(decision.instructions);
          const probabilities = Record.map(decision.criteria, (_criterion, key) =>
            key === "undetermined" ? 1 : 0,
          );
          return Classify({ label: "undetermined", probabilities });
        });
        return Effect.succeed({
          answers,
          usage: { inputTokens: undefined, outputTokens: undefined },
        });
      },
    }),
  );
  const hint = ["shared prior"];
  const options = { hints: hint };
  return Effect.gen(function* () {
    yield* Taxonomy.sameSpecies(subject, subject, options);
    yield* Taxonomy.sameTaxon(TaxonName.make("Fungi"), TaxonName.make("Plants"), options);
    yield* Taxonomy.taxonWithin(TaxonName.make("Fungi"), TaxonName.make("Plants"), options);
    yield* TaxonSet.isSubsetOf(target, other, options);
    yield* TaxonSet.isProperSubsetOf(TaxonSet.empty(), other, options);
    yield* TaxonSet.equivalent(target, other, options);
    yield* TaxonSet.overlaps(target, other, options);
    yield* TaxonSet.disjoint(target, other, options);
    yield* Taxonomy.recordBelongsTo(subject, target, options);
    yield* Taxonomy.partitionRecordsByMembership([subject], target, options);
    yield* Taxonomy.groupRecordsByTaxa([subject], [target], options);
    yield* Taxonomy.anyRecordBelongsTo([subject], target, options);
    yield* Taxonomy.noRecordBelongsTo([subject], target, options);
    expect(states).toHaveLength(13);
    for (const instruction of instructions.slice(0, 3))
      expect(instruction).toContain("shared prior");
    for (const state of states.slice(3)) expect(state).toMatchObject({ hints: hint });
  }).pipe(Effect.provide(model));
});

it.effect(
  "keeps scalar and delegated empty overrides identical to their unconfigured requests",
  () => {
    const requests: unknown[] = [];
    const model = Layer.effect(
      DecisionModel.DecisionModel,
      DecisionModel.make({
        decide: ({ state, decisions }) => {
          requests.push({ state, decisions });
          const answers = Record.map(decisions, (decision) => {
            if (decision._tag !== "Classify") throw new Error("Expected classification");
            return Classify({
              label: "undetermined",
              probabilities: Record.map(decision.criteria, (_value, key) =>
                key === "undetermined" ? 1 : 0,
              ),
            });
          });
          return Effect.succeed({
            answers,
            usage: { inputTokens: undefined, outputTokens: undefined },
          });
        },
      }),
    );
    return Effect.gen(function* () {
      yield* Taxonomy.sameTaxon(TaxonName.make("A"), TaxonName.make("B"));
      yield* Taxonomy.sameTaxon(TaxonName.make("A"), TaxonName.make("B"), { hints: [] }).pipe(
        Effect.provide(taxonomyHintsLayer(["hidden"])),
      );
      yield* Taxonomy.groupRecordsByTaxa([subject], [target]);
      yield* Taxonomy.groupRecordsByTaxa([subject], [target], { hints: [] }).pipe(
        Effect.provide(taxonomyHintsLayer(["hidden"])),
      );
      yield* Taxonomy.allRecordsBelongTo([subject], target);
      yield* Taxonomy.allRecordsBelongTo([subject], target, { hints: [] }).pipe(
        Effect.provide(taxonomyHintsLayer(["hidden"])),
      );
      expect(requests[1]).toEqual(requests[0]);
      expect(requests[3]).toEqual(requests[2]);
      expect(requests[5]).toEqual(requests[4]);
    }).pipe(Effect.provide(model));
  },
);

it.effect("isolates concurrent scopes and snapshots classification batches at execution", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const seen: unknown[] = [];
    const direct = ["before execution"];
    const model = Layer.effect(
      DecisionModel.DecisionModel,
      DecisionModel.make({
        decide: Effect.fnUntraced(function* ({ state }) {
          seen.push(state);
          if (seen.length === 1) {
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(release);
          }
          return {
            answers: {
              r0t0: Classify({
                label: "undetermined",
                probabilities: { sameTaxon: 0, withinTaxon: 0, noMatch: 0, undetermined: 1 },
              }),
            },
            usage: { inputTokens: undefined, outputTokens: undefined },
          };
        }),
      }),
    );
    const pending = Taxonomy.classifyRecords([subject, subject], target, {
      hints: direct,
      execution: CollectionExecution.make({ batchSize: 1, concurrency: 1 }),
    });
    direct[0] = "at execution";
    const fiber = yield* pending.pipe(Effect.provide(model), Effect.forkChild);
    yield* Deferred.await(started);
    direct[0] = "after start";
    yield* Taxonomy.classifyRecords([subject], target).pipe(
      Effect.provide(Layer.merge(model, taxonomyHintsLayer(["other scope"]))),
    );
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(fiber);
    expect(seen).toHaveLength(3);
    expect(seen[0]).toMatchObject({ hints: ["at execution"] });
    expect(seen[1]).toMatchObject({ hints: ["other scope"] });
    expect(seen[2]).toMatchObject({ hints: ["at execution"] });
  }),
);

it.effect("validates hints before transport while preserving literal shortcuts", () => {
  const model = Layer.effect(
    DecisionModel.DecisionModel,
    DecisionModel.make({
      decide: () => Effect.die("unexpected transport"),
    }),
  );
  return Effect.gen(function* () {
    for (const hints of [[42], null, 42, ""]) {
      const invalidClassification = yield* Effect.flip(
        // @ts-expect-error Verify an untyped caller's malformed hints.
        Taxonomy.classifyRecords([subject], target, { hints }),
      );
      expect(invalidClassification).toMatchObject({ _tag: "InvalidInput" });
      const invalidComparison = yield* Effect.flip(
        // @ts-expect-error Verify the scalar request path too.
        Taxonomy.sameTaxon(TaxonName.make("A"), TaxonName.make("B"), { hints }),
      );
      expect(invalidComparison).toMatchObject({ _tag: "InvalidInput" });
      // @ts-expect-error Literal shortcuts do not need hint validation or a model.
      const empty = yield* Taxonomy.recordBelongsTo(subject, TaxonSet.empty(), { hints });
      expect(empty._tag).toBe("NotMember");
      // @ts-expect-error Empty classification does not consume hints.
      const noRecords = yield* Taxonomy.classifyRecords([], target, { hints });
      expect(noRecords.records).toEqual([]);
      // @ts-expect-error An empty panel also makes no model request.
      const noTaxa = yield* Taxonomy.classifyRecords([subject], TaxonSet.empty(), { hints });
      expect(noTaxa.records[0]?.taxa).toEqual([]);
    }
  }).pipe(Effect.provide(model));
});
