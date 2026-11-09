import { expect, it } from "@effect/vitest";
import { Array, Data, Deferred, Effect, Fiber, Layer, Option, Record, Schema } from "effect";
import { DecisionModel } from "effect/ai";
import {
  CollectionExecution,
  RecordLabel,
  TaxonName,
  TaxonSet,
  Taxonomy,
  TaxonomyHint,
  TaxonomyHints,
} from "../src/index.ts";
import * as TestJson from "./Json.ts";

const { Classify } = Data.taggedEnum<DecisionModel.ProviderClassifyAnswer>();
const subject = RecordLabel.make("subject");
const target = TaxonSet.of(TaxonName.make("Fungi"));
const other = TaxonSet.of(TaxonName.make("Plants"));

it.effect("captures independent validated hints from the scope or an explicit collection", () =>
  Effect.gen(function* () {
    const empty = yield* TaxonomyHints.snapshot();
    expect(empty).toEqual([]);
    const capture = TaxonomyHints.snapshot();
    const scoped = [TaxonomyHint.make("scoped")];
    const inherited = yield* capture.pipe(Effect.provideService(TaxonomyHints.Current, scoped));
    const inheritedUndefined = yield* TaxonomyHints.snapshot(undefined).pipe(
      Effect.provideService(TaxonomyHints.Current, scoped),
    );
    expect(inherited).not.toBe(scoped);
    expect(inheritedUndefined).toEqual(["scoped"]);
    scoped.push(TaxonomyHint.make("later"));
    expect(inherited).toEqual(["scoped"]);
    const recaptured = yield* capture.pipe(Effect.provideService(TaxonomyHints.Current, scoped));
    expect(recaptured).toEqual(["scoped", "later"]);

    const placement = TaxonomyHint.make(" \tQuercus belongs to Fagaceae.\n");
    const explicit = [placement, placement];
    const pending = TaxonomyHints.snapshot(explicit);
    explicit.push(TaxonomyHint.make("before execution"));
    const captured = yield* pending.pipe(TaxonomyHints.withHints(scoped));
    expect(captured).not.toBe(explicit);
    explicit.push(TaxonomyHint.make("after execution"));
    expect(captured).toEqual([placement, placement, "before execution"]);
    const disabled = yield* TaxonomyHints.snapshot([]).pipe(TaxonomyHints.withHints(scoped));
    expect(disabled).toEqual([]);
  }),
);

it.effect("selects scoped, direct, empty and updated hints without leaking scopes", () => {
  const seen: DecisionModel.ProviderOptions["state"][] = [];
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
  const source = [TaxonomyHint.make("outer")];
  const hintsLayer = TaxonomyHints.layer(source);
  source.push(TaxonomyHint.make("later"));
  return Effect.gen(function* () {
    yield* operation;
    yield* operation.pipe(Effect.provide(hintsLayer));
    yield* Effect.gen(function* () {
      const before = yield* TaxonomyHints.Current;
      expect(before).toEqual(["replacement", "inner"]);
      yield* Taxonomy.classifyRecords([subject], target, { hints: [TaxonomyHint.make("direct")] });
      const afterDirect = yield* TaxonomyHints.Current;
      expect(afterDirect).toBe(before);
      yield* Taxonomy.classifyRecords([subject], target, { hints: [] });
      const afterDisabled = yield* TaxonomyHints.Current;
      expect(afterDisabled).toBe(before);
    }).pipe(
      TaxonomyHints.withAddedHints([TaxonomyHint.make("inner")]),
      TaxonomyHints.withHints([TaxonomyHint.make("replacement")]),
      Effect.provide(hintsLayer),
    );
    yield* operation.pipe(
      TaxonomyHints.withAddedHints([TaxonomyHint.make("inner")]),
      Effect.provide(hintsLayer),
    );
    yield* operation.pipe(Effect.provide(hintsLayer));
    yield* Taxonomy.classifyRecords([subject], target, { hints: undefined }).pipe(
      Effect.provide(hintsLayer),
    );
    yield* operation.pipe(
      TaxonomyHints.withHints([TaxonomyHint.make("replacement")]),
      Effect.provide(hintsLayer),
    );
    expect(seen).toHaveLength(8);
    const baseline = Array.get(seen, 0).pipe(Option.getOrThrow);
    const shared = Array.get(seen, 1).pipe(Option.getOrThrow);
    const direct = Array.get(seen, 2).pipe(Option.getOrThrow);
    const disabled = Array.get(seen, 3).pipe(Option.getOrThrow);
    const supplemented = Array.get(seen, 4).pipe(Option.getOrThrow);
    const restored = Array.get(seen, 5).pipe(Option.getOrThrow);
    const inherited = Array.get(seen, 6).pipe(Option.getOrThrow);
    const replaced = Array.get(seen, 7).pipe(Option.getOrThrow);
    expect(disabled).toEqual(baseline);
    expect(shared).toMatchObject({ hints: ["outer"] });
    expect(direct).toMatchObject({ hints: ["direct"] });
    expect(supplemented).toMatchObject({ hints: ["outer", "inner"] });
    expect(restored).toEqual(shared);
    expect(inherited).toEqual(shared);
    expect(replaced).toMatchObject({ hints: ["replacement"] });
  }).pipe(Effect.provide(model));
});

it.effect(
  "exposes scoped replacement and immutable ordered additions without changing outer hints",
  () =>
    Effect.gen(function* () {
      const initial = yield* TaxonomyHints.Current;
      expect(initial).toEqual([]);
      const outer = [TaxonomyHint.make("outer")];
      const replacement = TaxonomyHint.make("replacement");
      const added = TaxonomyHint.make("added");
      yield* Effect.gen(function* () {
        const before = yield* TaxonomyHints.Current;
        expect(before).toEqual(["outer"]);
        yield* Effect.gen(function* () {
          const replaced = yield* TaxonomyHints.Current;
          expect(replaced).toEqual(["replacement"]);
          const appended = yield* TaxonomyHints.Current.pipe(
            TaxonomyHints.withAddedHints([added, added]),
          );
          expect(appended).toEqual(["replacement", "added", "added"]);
          const afterAppend = yield* TaxonomyHints.Current;
          expect(afterAppend).toBe(replaced);
        }).pipe(TaxonomyHints.withHints([replacement]));
        const afterReplacement = yield* TaxonomyHints.Current;
        expect(afterReplacement).toBe(before);
        const nativeAppend = yield* TaxonomyHints.Current.pipe(
          Effect.updateService(TaxonomyHints.Current, Array.append(added)),
        );
        expect(nativeAppend).toEqual(["outer", "added"]);
        expect(before).toEqual(["outer"]);
        expect(outer).toEqual(["outer"]);
        const afterNativeAppend = yield* TaxonomyHints.Current;
        expect(afterNativeAppend).toBe(before);
      }).pipe(Effect.provide(TaxonomyHints.layer(outer)));
      const restored = yield* TaxonomyHints.Current;
      expect(restored).toBe(initial);
    }),
);

it.effect("copies helper inputs at construction but inherits ambient hints on each execution", () =>
  Effect.gen(function* () {
    const additions = [TaxonomyHint.make("added")];
    const replacements = [TaxonomyHint.make("replacement")];
    const supplemented = TaxonomyHints.Current.pipe(TaxonomyHints.withAddedHints(additions));
    const replaced = TaxonomyHints.Current.pipe(TaxonomyHints.withHints(replacements));
    additions.push(TaxonomyHint.make("too late"));
    replacements[0] = TaxonomyHint.make("too late");
    const first = TaxonomyHints.layer([TaxonomyHint.make("first")]);
    const second = TaxonomyHints.layer([TaxonomyHint.make("second")]);
    const firstSupplemented = yield* supplemented.pipe(Effect.provide(first));
    const secondSupplemented = yield* supplemented.pipe(Effect.provide(second));
    const firstReplaced = yield* replaced.pipe(Effect.provide(first));
    const secondReplaced = yield* replaced.pipe(Effect.provide(second));
    expect(firstSupplemented).toEqual(["first", "added"]);
    expect(secondSupplemented).toEqual(["second", "added"]);
    expect(firstReplaced).toEqual(["replacement"]);
    expect(secondReplaced).toEqual(["replacement"]);
    const outside = yield* TaxonomyHints.Current;
    expect(outside).toEqual([]);
  }),
);

it.effect("snapshots group hints before the first request for later targets", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const seen: DecisionModel.ProviderOptions["state"][] = [];
    const hints = [TaxonomyHint.make("initial")];
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
    hints.push(TaxonomyHint.make("mutated"));
    yield* Deferred.succeed(release, undefined);
    const result = yield* Fiber.join(fiber);
    expect(result.groups).toHaveLength(2);
    expect(seen).toHaveLength(2);
    for (const state of seen) expect(state).toMatchObject({ hints: ["initial"] });
  }),
);

it.effect("carries hints through successive quantifier windows", () => {
  const seen: DecisionModel.ProviderOptions["state"][] = [];
  const hints = [TaxonomyHint.make("prior")];
  const model = Layer.effect(
    DecisionModel.DecisionModel,
    DecisionModel.make({
      decide: ({ state, decisions }) => {
        seen.push(state);
        hints.push(TaxonomyHint.make("mutated"));
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
  const states: DecisionModel.ProviderOptions["state"][] = [];
  const instructions: string[] = [];
  const model = Layer.effect(
    DecisionModel.DecisionModel,
    DecisionModel.make({
      decide: ({ state, decisions }) => {
        states.push(state);
        const answers = Record.map(decisions, (decision) => {
          if (decision._tag !== "Classify") throw new Error("Expected classification");
          const instruction = Schema.decodeUnknownSync(Schema.String)(decision.instructions);
          instructions.push(instruction);
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
  const hint = [TaxonomyHint.make(" \tshared prior\n")];
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
    const quotedHint = yield* TestJson.encode(" \tshared prior\n");
    for (const instruction of instructions.slice(0, 3)) expect(instruction).toContain(quotedHint);
    for (const state of states.slice(3)) expect(state).toMatchObject({ hints: hint });
  }).pipe(Effect.provide(model));
});

it.effect(
  "keeps scalar and delegated empty overrides identical to their unconfigured requests",
  () => {
    const requests: Pick<DecisionModel.ProviderOptions, "state" | "decisions">[] = [];
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
        Effect.provide(TaxonomyHints.layer([TaxonomyHint.make("hidden")])),
      );
      yield* Taxonomy.groupRecordsByTaxa([subject], [target]);
      yield* Taxonomy.groupRecordsByTaxa([subject], [target], { hints: [] }).pipe(
        Effect.provide(TaxonomyHints.layer([TaxonomyHint.make("hidden")])),
      );
      yield* Taxonomy.allRecordsBelongTo([subject], target);
      yield* Taxonomy.allRecordsBelongTo([subject], target, { hints: [] }).pipe(
        Effect.provide(TaxonomyHints.layer([TaxonomyHint.make("hidden")])),
      );
      expect(requests).toHaveLength(6);
      const scalarBaseline = Array.get(requests, 0).pipe(Option.getOrThrow);
      const scalarDisabled = Array.get(requests, 1).pipe(Option.getOrThrow);
      const groupBaseline = Array.get(requests, 2).pipe(Option.getOrThrow);
      const groupDisabled = Array.get(requests, 3).pipe(Option.getOrThrow);
      const quantifierBaseline = Array.get(requests, 4).pipe(Option.getOrThrow);
      const quantifierDisabled = Array.get(requests, 5).pipe(Option.getOrThrow);
      expect(scalarDisabled).toEqual(scalarBaseline);
      expect(groupDisabled).toEqual(groupBaseline);
      expect(quantifierDisabled).toEqual(quantifierBaseline);
    }).pipe(Effect.provide(model));
  },
);

it.effect("isolates concurrent scopes and snapshots classification batches at execution", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const seen: DecisionModel.ProviderOptions["state"][] = [];
    const direct = [TaxonomyHint.make("before execution")];
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
    direct[0] = TaxonomyHint.make("at execution");
    const fiber = yield* pending.pipe(Effect.provide(model), Effect.forkChild);
    yield* Deferred.await(started);
    direct[0] = TaxonomyHint.make("after start");
    yield* Taxonomy.classifyRecords([subject], target).pipe(
      Effect.provide(Layer.merge(model, TaxonomyHints.layer([TaxonomyHint.make("other scope")]))),
    );
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(fiber);
    expect(seen).toHaveLength(3);
    const firstBatch = Array.get(seen, 0).pipe(Option.getOrThrow);
    const otherScope = Array.get(seen, 1).pipe(Option.getOrThrow);
    const secondBatch = Array.get(seen, 2).pipe(Option.getOrThrow);
    expect(firstBatch).toMatchObject({ hints: ["at execution"] });
    expect(otherScope).toMatchObject({ hints: ["other scope"] });
    expect(secondBatch).toMatchObject({ hints: ["at execution"] });
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
    for (const hints of [[42], null, 42, "", [""], [" \t\n"]]) {
      const invalidSnapshot = yield* Effect.flip(
        // @ts-expect-error Verify an untyped caller's malformed snapshot inputs.
        TaxonomyHints.snapshot(hints),
      );
      expect(invalidSnapshot).toMatchObject({ _tag: "InvalidInput" });
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
      expect(noTaxa.records).toHaveLength(1);
      const row = Array.head(noTaxa.records).pipe(Option.getOrThrow);
      expect(row.taxa).toEqual([]);
    }
  }).pipe(Effect.provide(model));
});
