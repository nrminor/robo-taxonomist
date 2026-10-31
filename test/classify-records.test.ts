import { expect, it } from "@effect/vitest";
import { Array, Deferred, Effect, Fiber, Layer, Option, Record, Schema } from "effect";
import { AiError, DecisionModel } from "effect/ai";
import {
  AcceptancePolicy,
  CollectionExecution,
  RecordLabel,
  TaxonId,
  TaxonName,
  TaxonSet,
  Taxonomy,
} from "../src/index.ts";

const answer = (
  label: string,
  [sameTaxon, withinTaxon, noMatch, undetermined]: readonly [number, number, number, number],
): DecisionModel.ProviderClassifyAnswer => ({
  _tag: "Classify",
  label,
  probabilities: { sameTaxon, withinTaxon, noMatch, undetermined },
});

const inputSchema = Schema.Struct({
  records: Schema.Array(Schema.String),
  taxa: Schema.Array(Schema.Struct({ scientificName: Schema.String })),
});

const boundedTaxon = (name: string) => {
  const taxon = TaxonSet.of(TaxonName.make(name));
  let reads = 0;
  Object.defineProperty(taxon, "_tag", {
    get: () => {
      if (++reads > 1000) throw new Error("Panel traversal exhausted the test read budget");
      return "Taxon";
    },
  });
  return taxon;
};

// Supplied answers test classification contracts, not biological accuracy.
it.effect("ranks several supported taxa while preserving original records and taxon nodes", () => {
  const record = {
    scientificName: TaxonName.make("Saccharomyces cerevisiae"),
    sequenceAbundance: 8,
    sampleId: "sample-17",
  };
  const genus = TaxonSet.of(TaxonName.make("Saccharomyces"));
  const species = TaxonSet.of(TaxonName.make("Saccharomyces cerevisiae"));
  const bacteria = TaxonSet.of(TaxonName.make("Lactobacillaceae"));
  const panel = TaxonSet.union(genus, TaxonSet.union(species, bacteria));
  const layer = Layer.effect(
    DecisionModel.DecisionModel,
    DecisionModel.make({
      decide: ({ state }) => {
        const input = Schema.decodeUnknownSync(inputSchema)(state);
        expect(input.records).toEqual(['Scientific name: "Saccharomyces cerevisiae"']);
        expect(input.taxa).toEqual([
          { scientificName: "Saccharomyces" },
          { scientificName: "Saccharomyces cerevisiae" },
          { scientificName: "Lactobacillaceae" },
        ]);
        return Effect.succeed({
          answers: {
            r0t0: answer("withinTaxon", [0.01, 0.96, 0.01, 0.02]),
            r0t1: answer("sameTaxon", [0.94, 0.01, 0.02, 0.03]),
            r0t2: answer("noMatch", [0.01, 0.01, 0.96, 0.02]),
          },
          usage: { inputTokens: 101, outputTokens: 53 },
        });
      },
    }),
  );

  return Effect.gen(function* () {
    const results = yield* Taxonomy.classifyRecords([record], panel, {
      policy: AcceptancePolicy.make({ minimumSupport: 0.8, minimumMargin: 0.1 }),
    });
    const row = Array.head(results.records).pipe(Option.getOrThrow);
    const first = Array.head(row.taxa).pipe(Option.getOrThrow);

    expect(results.panel).toBe(panel);
    expect(row.record).toBe(record);
    expect(row.taxa.map((match) => match.taxon)).toEqual([genus, species, bacteria]);
    expect(first.taxon).toBe(genus);
    expect(first.record).toBe(record);
    expect(first.pipe((match) => match.record.sampleId)).toBe("sample-17");
    expect(first.record.sequenceAbundance).toBe(8);
    expect(row.taxa.map((match) => match.judgment._tag)).toEqual([
      "Matched",
      "Matched",
      "NotMatched",
    ]);
    expect(row.ranking.map((match) => match.taxon.record.scientificName)).toEqual([
      "Saccharomyces",
      "Saccharomyces cerevisiae",
    ]);
    expect(row.ranking.map((match) => match.support)).toEqual([0.97, 0.95]);
    expect(Array.head(row.ranking).pipe(Option.getOrThrow)).toBe(first);
    expect(first.answer.label).toBe("withinTaxon");
    expect(first.answer.probabilities.withinTaxon).toBe(0.96);
    expect(results.usage).toHaveLength(1);
    expect(results.usage[0]).toMatchObject({ inputTokens: 101, outputTokens: 53 });
  }).pipe(Effect.provide(layer));
});

it.effect("separates negative evidence from uncertainty and preserves rounded answers", () => {
  const records = ["negative", "unknown", "combined", "tie", "rounded"].map((label) =>
    RecordLabel.make(label),
  );
  const panel = TaxonSet.of(TaxonName.make("Saccharomyces"));
  const layer = Layer.effect(
    DecisionModel.DecisionModel,
    DecisionModel.make({
      decide: () =>
        Effect.succeed({
          answers: {
            r0t0: answer("noMatch", [0.04, 0.06, 0.85, 0.05]),
            r1t0: answer("undetermined", [0.04, 0.06, 0.05, 0.85]),
            r2t0: answer("noMatch", [0.4, 0.45, 0.1, 0.05]),
            r3t0: answer("noMatch", [0.2, 0.3, 0.5, 0]),
            r4t0: answer("sameTaxon", [0.7, 0.3000002, 0, 0]),
          },
          usage: { inputTokens: undefined, outputTokens: undefined },
        }),
    }),
  );

  return Effect.gen(function* () {
    const result = yield* Taxonomy.classifyRecords(records, panel);
    const matches = result.records.flatMap((row) => row.taxa);
    expect(matches.map((match) => match.judgment._tag)).toEqual([
      "NotMatched",
      "Undetermined",
      "Matched",
      "Undetermined",
      "Matched",
    ]);
    expect(matches.map((match) => match.support)).toEqual([0.1, 0.1, 0.85, 0.5, 1]);
    expect(result.records.map((row) => row.ranking.length)).toEqual([0, 0, 1, 0, 1]);
    expect(matches[2]?.answer.label).toBe("noMatch");
    expect(matches[4]?.answer.probabilities.withinTaxon).toBe(0.3000002);
  }).pipe(Effect.provide(layer));
});

it.effect("returns original records with no comparisons or requests for empty inputs", () => {
  const record = { label: RecordLabel.make("subject"), abundance: 8 };
  const taxon = TaxonSet.of(TaxonName.make("Fungi"));
  const empty = TaxonSet.empty();
  const layer = Layer.effect(
    DecisionModel.DecisionModel,
    DecisionModel.make({ decide: () => Effect.die("No provider request expected") }),
  );

  return Effect.gen(function* () {
    const noRecords = yield* Taxonomy.classifyRecords([], taxon);
    expect(noRecords).toEqual({ panel: taxon, records: [], usage: [] });

    for (const panel of [empty, TaxonSet.union(empty, empty), TaxonSet.difference(empty, taxon)]) {
      const result = yield* Taxonomy.classifyRecords([record, record], panel);
      expect(result.panel).toBe(panel);
      expect(result.usage).toEqual([]);
      expect(result.records).toHaveLength(2);
      for (const row of result.records) {
        expect(row.record).toBe(record);
        expect(row.taxa).toEqual([]);
        expect(row.ranking).toEqual([]);
      }
    }
  }).pipe(Effect.provide(layer));
});

it.effect("keeps nested subtraction in context and restores its included taxon", () => {
  const fungi = TaxonSet.of(TaxonName.make("Fungi"));
  const yeasts = TaxonSet.of(TaxonName.make("Saccharomyces"));
  const species = TaxonSet.of(TaxonName.make("Saccharomyces cerevisiae"));
  const panel = TaxonSet.difference(fungi, TaxonSet.difference(yeasts, species));
  const records = [
    { scientificName: TaxonName.make("Saccharomyces cerevisiae") },
    { taxonId: TaxonId.make({ taxonomy: "ncbi", id: "5476", release: "fixture-release" }) },
    RecordLabel.make("Saccharomyces paradoxus"),
  ];
  const layer = Layer.effect(
    DecisionModel.DecisionModel,
    DecisionModel.make({
      decide: ({ state }) => {
        const input = Schema.decodeUnknownSync(inputSchema)(state);
        expect(input.taxa).toEqual([
          { scientificName: "Fungi" },
          { scientificName: "Saccharomyces cerevisiae" },
        ]);
        expect(input.records).toEqual([
          'Scientific name: "Saccharomyces cerevisiae"',
          'Taxonomy: "ncbi"\nTaxon ID: "5476"\nTaxonomy release: "fixture-release"',
          'Record label: "Saccharomyces paradoxus"',
        ]);
        expect(state).toMatchObject({
          nodes: expect.arrayContaining([
            expect.objectContaining({ _tag: "Difference" }),
            { _tag: "Taxon", record: { scientificName: "Saccharomyces" } },
          ]),
        });
        return Effect.succeed({
          answers: {
            r0t0: answer("withinTaxon", [0.01, 0.94, 0.02, 0.03]),
            r0t1: answer("sameTaxon", [0.94, 0.01, 0.02, 0.03]),
            r1t0: answer("withinTaxon", [0.01, 0.94, 0.02, 0.03]),
            r1t1: answer("noMatch", [0.01, 0.01, 0.96, 0.02]),
            r2t0: answer("noMatch", [0.01, 0.01, 0.96, 0.02]),
            r2t1: answer("noMatch", [0.01, 0.01, 0.96, 0.02]),
          },
          usage: { inputTokens: undefined, outputTokens: undefined },
        });
      },
    }),
  );

  return Effect.gen(function* () {
    const result = yield* Taxonomy.classifyRecords(records, panel);
    expect(
      result.records.map((row) => row.ranking.map((match) => match.taxon.record.scientificName)),
    ).toEqual([["Fungi", "Saccharomyces cerevisiae"], ["Fungi"], []]);
    for (const row of result.records) {
      expect(row.taxa[0]?.taxon).toBe(fungi);
      expect(row.taxa[1]?.taxon).toBe(species);
    }
  }).pipe(Effect.provide(layer));
});

it.effect(
  "preserves repeated occurrences through intersections and keeps ranking ties stable",
  () => {
    const record = { scientificName: TaxonName.make("Saccharomyces cerevisiae"), sampleId: "same" };
    const genus = TaxonSet.of(TaxonName.make("Saccharomyces"));
    const species = TaxonSet.of(TaxonName.make("Saccharomyces cerevisiae"));
    const shared = TaxonSet.union(genus, species);
    const panel = TaxonSet.intersection(shared, shared);
    const layer = Layer.effect(
      DecisionModel.DecisionModel,
      DecisionModel.make({
        decide: ({ state }) => {
          const input = Schema.decodeUnknownSync(inputSchema)(state);
          expect(input.taxa).toEqual([
            { scientificName: "Saccharomyces" },
            { scientificName: "Saccharomyces cerevisiae" },
            { scientificName: "Saccharomyces" },
            { scientificName: "Saccharomyces cerevisiae" },
          ]);
          return Effect.succeed({
            answers: {
              r0t0: answer("withinTaxon", [0.01, 0.94, 0.02, 0.03]),
              r0t1: answer("sameTaxon", [0.94, 0.01, 0.02, 0.03]),
              r0t2: answer("noMatch", [0.01, 0.01, 0.96, 0.02]),
              r0t3: answer("sameTaxon", [0.94, 0.01, 0.02, 0.03]),
              r1t0: answer("noMatch", [0.01, 0.01, 0.96, 0.02]),
              r1t1: answer("sameTaxon", [0.94, 0.01, 0.02, 0.03]),
              r1t2: answer("withinTaxon", [0.01, 0.94, 0.02, 0.03]),
              r1t3: answer("sameTaxon", [0.94, 0.01, 0.02, 0.03]),
            },
            usage: { inputTokens: undefined, outputTokens: undefined },
          });
        },
      }),
    );

    return Effect.gen(function* () {
      const result = yield* Taxonomy.classifyRecords([record, record], panel);
      const first = Array.head(result.records).pipe(Option.getOrThrow);
      const last = Array.last(result.records).pipe(Option.getOrThrow);
      for (const row of result.records) {
        expect(row.record).toBe(record);
        expect(row.taxa.map((match) => match.taxon)).toEqual([genus, species, genus, species]);
        expect(row.taxa[0]?.taxon).toBe(genus);
        expect(row.taxa[2]?.taxon).toBe(genus);
        expect(row.taxa[0]).not.toBe(row.taxa[2]);
      }
      expect(first.ranking).toEqual([first.taxa[0], first.taxa[1], first.taxa[3]]);
      expect(last.ranking).toEqual([last.taxa[1], last.taxa[2], last.taxa[3]]);
      expect(first.taxa[0]?.judgment._tag).toBe("Matched");
      expect(last.taxa[0]?.judgment._tag).toBe("NotMatched");
      expect(first.taxa[0]).not.toBe(last.taxa[0]);
    }).pipe(Effect.provide(layer));
  },
);

it.effect("does not expand shared positive occurrences when there are no records", () => {
  let panel: TaxonSet.TaxonSet = boundedTaxon("Saccharomyces");
  for (let depth = 0; depth < 40; depth++) panel = TaxonSet.union(panel, panel);
  const layer = Layer.effect(
    DecisionModel.DecisionModel,
    DecisionModel.make({ decide: () => Effect.die("No provider request expected") }),
  );
  return Effect.gen(function* () {
    const result = yield* Taxonomy.classifyRecords([], panel);
    expect(result.panel).toBe(panel);
    expect(result.records).toEqual([]);
    expect(result.usage).toEqual([]);
  }).pipe(Effect.provide(layer));
});

it.effect("does not repeatedly expand shared subtraction branches that offer no taxa", () => {
  const fungi = TaxonSet.of(TaxonName.make("Fungi"));
  let excluded: TaxonSet.TaxonSet = boundedTaxon("Saccharomyces");
  for (let depth = 0; depth < 40; depth++) excluded = TaxonSet.union(excluded, excluded);
  const panel = TaxonSet.difference(fungi, excluded);
  const record = RecordLabel.make("Candida albicans");
  const layer = Layer.effect(
    DecisionModel.DecisionModel,
    DecisionModel.make({
      decide: ({ state }) => {
        expect(Schema.decodeUnknownSync(inputSchema)(state).taxa).toEqual([
          { scientificName: "Fungi" },
        ]);
        return Effect.succeed({
          answers: { r0t0: answer("withinTaxon", [0.01, 0.94, 0.02, 0.03]) },
          usage: { inputTokens: undefined, outputTokens: undefined },
        });
      },
    }),
  );
  return Effect.gen(function* () {
    const result = yield* Taxonomy.classifyRecords([record], panel);
    expect(result.records[0]?.ranking[0]?.taxon).toBe(fungi);
  }).pipe(Effect.provide(layer));
});

it.effect("retains a shared taxon when it also occurs outside subtraction", () => {
  const taxon = TaxonSet.of(TaxonName.make("Fungi"));
  const empty = TaxonSet.empty();
  const shared = TaxonSet.union(taxon, empty);
  const panel = TaxonSet.union(TaxonSet.difference(empty, shared), shared);
  const layer = Layer.effect(
    DecisionModel.DecisionModel,
    DecisionModel.make({
      decide: ({ state }) => {
        expect(Schema.decodeUnknownSync(inputSchema)(state).taxa).toEqual([
          { scientificName: "Fungi" },
        ]);
        return Effect.succeed({
          answers: { r0t0: answer("withinTaxon", [0.01, 0.94, 0.02, 0.03]) },
          usage: { inputTokens: undefined, outputTokens: undefined },
        });
      },
    }),
  );
  return Effect.gen(function* () {
    const result = yield* Taxonomy.classifyRecords([RecordLabel.make("subject")], panel);
    expect(result.records[0]?.ranking[0]?.taxon).toBe(taxon);
  }).pipe(Effect.provide(layer));
});

it.effect("classifies deeply nested panels without recursive source traversal", () => {
  const taxon = TaxonSet.of(TaxonName.make("Fungi"));
  const empty = TaxonSet.empty();
  let panel: TaxonSet.TaxonSet = taxon;
  for (let depth = 0; depth < 5000; depth++) panel = TaxonSet.union(empty, panel);
  const layer = Layer.effect(
    DecisionModel.DecisionModel,
    DecisionModel.make({
      decide: () =>
        Effect.succeed({
          answers: { r0t0: answer("withinTaxon", [0.01, 0.94, 0.02, 0.03]) },
          usage: { inputTokens: undefined, outputTokens: undefined },
        }),
    }),
  );
  return Effect.gen(function* () {
    const result = yield* Taxonomy.classifyRecords([RecordLabel.make("subject")], panel);
    expect(result.records[0]?.ranking[0]?.taxon).toBe(taxon);
  }).pipe(Effect.provide(layer));
});

it.effect("preserves record and usage order when concurrent requests finish out of order", () =>
  Effect.gen(function* () {
    const firstStarted = yield* Deferred.make<void>();
    const releaseFirst = yield* Deferred.make<void>();
    const records = ["first", "second", "third"].map((label) => ({
      label: RecordLabel.make(label),
      sampleId: label,
    }));
    const genus = TaxonSet.of(TaxonName.make("Saccharomyces"));
    const species = TaxonSet.of(TaxonName.make("Saccharomyces cerevisiae"));
    const panel = TaxonSet.union(genus, species);
    const descriptions = [
      'Record label: "first"',
      'Record label: "second"',
      'Record label: "third"',
    ];
    const finished: number[] = [];
    let active = 0;
    let maximum = 0;
    const layer = Layer.effect(
      DecisionModel.DecisionModel,
      DecisionModel.make({
        decide: Effect.fnUntraced(function* ({ state }) {
          const input = Schema.decodeUnknownSync(inputSchema)(state);
          expect(input.records).toHaveLength(1);
          expect(input.taxa).toEqual([
            { scientificName: "Saccharomyces" },
            { scientificName: "Saccharomyces cerevisiae" },
          ]);
          const index = descriptions.indexOf(Array.head(input.records).pipe(Option.getOrThrow));
          expect(index).toBeGreaterThanOrEqual(0);
          active++;
          maximum = Math.max(maximum, active);
          if (index === 0) {
            yield* Deferred.succeed(firstStarted, undefined);
            yield* Deferred.await(releaseFirst);
          } else if (index === 1) {
            yield* Deferred.await(firstStarted);
            finished.push(index);
            yield* Deferred.succeed(releaseFirst, undefined);
          }
          if (index !== 1) finished.push(index);
          active--;
          return {
            answers: {
              r0t0: answer("withinTaxon", [0.01, 0.94, 0.02, 0.03]),
              r0t1: answer("sameTaxon", [0.94, 0.01, 0.02, 0.03]),
            },
            usage: { inputTokens: index * 10 + 1, outputTokens: index * 10 + 2 },
          };
        }),
      }),
    );
    const result = yield* Taxonomy.classifyRecords(records, panel, {
      execution: CollectionExecution.make({ batchSize: 1, concurrency: 2 }),
    }).pipe(Effect.provide(layer));
    expect(finished[0]).toBe(1);
    expect(maximum).toBe(2);
    expect(result.records.map((row) => row.record)).toEqual(records);
    expect(result.records.map((row) => row.taxa[0]?.record.sampleId)).toEqual([
      "first",
      "second",
      "third",
    ]);
    expect(result.usage.map((usage) => usage.inputTokens)).toEqual([1, 11, 21]);
    expect(result.usage.map((usage) => usage.outputTokens)).toEqual([2, 12, 22]);
    for (const [index, row] of result.records.entries()) expect(row.record).toBe(records[index]);
  }),
);

it.effect("reuses the default 16-record serial batches while keeping the full panel", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const sizes: number[] = [];
    const heads: number[] = [];
    const panel = TaxonSet.union(
      TaxonSet.of(TaxonName.make("Saccharomyces")),
      TaxonSet.of(TaxonName.make("Saccharomyces cerevisiae")),
    );
    const layer = Layer.effect(
      DecisionModel.DecisionModel,
      DecisionModel.make({
        decide: Effect.fnUntraced(function* ({ state, decisions }) {
          const input = Schema.decodeUnknownSync(inputSchema)(state);
          sizes.push(input.records.length);
          heads.push(Record.size(decisions));
          expect(input.taxa).toEqual([
            { scientificName: "Saccharomyces" },
            { scientificName: "Saccharomyces cerevisiae" },
          ]);
          yield* Deferred.succeed(started, undefined);
          yield* Deferred.await(release);
          return {
            answers: Record.map(decisions, () => answer("withinTaxon", [0.01, 0.94, 0.02, 0.03])),
            usage: { inputTokens: undefined, outputTokens: undefined },
          };
        }),
      }),
    );
    const record = RecordLabel.make("subject");
    const fiber = yield* Taxonomy.classifyRecords(Array.replicate(record, 33), panel).pipe(
      Effect.provide(layer),
      Effect.forkChild,
    );
    yield* Deferred.await(started);
    expect(sizes).toEqual([16]);
    yield* Deferred.succeed(release, undefined);
    const result = yield* Fiber.join(fiber);
    expect(sizes).toEqual([16, 16, 1]);
    expect(heads).toEqual([32, 32, 2]);
    expect(result.records).toHaveLength(33);
    expect(result.usage).toHaveLength(3);
  }),
);

it.effect("propagates provider failure without returning a partial ranking", () => {
  const failure = AiError.make({
    module: "TestProvider",
    method: "decide",
    reason: new AiError.UnknownError({ description: "fixture failure" }),
  });
  let calls = 0;
  const layer = Layer.effect(
    DecisionModel.DecisionModel,
    DecisionModel.make({
      decide: () => {
        calls++;
        return calls === 1
          ? Effect.succeed({
              answers: { r0t0: answer("withinTaxon", [0.01, 0.94, 0.02, 0.03]) },
              usage: { inputTokens: undefined, outputTokens: undefined },
            })
          : Effect.fail(failure);
      },
    }),
  );
  return Effect.gen(function* () {
    const result = yield* Effect.flip(
      Taxonomy.classifyRecords(
        Array.replicate(RecordLabel.make("subject"), 3),
        TaxonSet.of(TaxonName.make("Fungi")),
        { execution: CollectionExecution.make({ batchSize: 1, concurrency: 1 }) },
      ),
    );
    expect(result).toBe(failure);
    expect(calls).toBe(2);
  }).pipe(Effect.provide(layer));
});

it.effect("fails when a requested taxon answer is missing", () => {
  const panel = TaxonSet.union(
    TaxonSet.of(TaxonName.make("Fungi")),
    TaxonSet.of(TaxonName.make("Saccharomyces")),
  );
  const layer = Layer.effect(
    DecisionModel.DecisionModel,
    DecisionModel.make({
      decide: () =>
        Effect.succeed({
          answers: { r0t0: answer("withinTaxon", [0.01, 0.94, 0.02, 0.03]) },
          usage: { inputTokens: undefined, outputTokens: undefined },
        }),
    }),
  );
  return Effect.gen(function* () {
    const failure = yield* Effect.flip(
      Taxonomy.classifyRecords([RecordLabel.make("subject")], panel),
    );
    expect(failure.reason._tag).toBe("InvalidOutputError");
  }).pipe(Effect.provide(layer));
});

it.effect("rejects malformed records and cyclic or nonnominal panels before transport", () => {
  const taxon = TaxonSet.of(TaxonName.make("Fungi"));
  const malformed = { _tag: "Difference", left: taxon };
  const cyclic = TaxonSet.union(taxon, TaxonSet.empty());
  Reflect.set(cyclic, "operands", [cyclic]);
  const layer = Layer.effect(
    DecisionModel.DecisionModel,
    DecisionModel.make({ decide: () => Effect.die("No provider request expected") }),
  );
  return Effect.gen(function* () {
    const invalid = [
      Taxonomy.classifyRecords([RecordLabel.make("subject")], cyclic),
      // @ts-expect-error Untyped input lacks an identifying description.
      Taxonomy.classifyRecords([{}], taxon),
      // @ts-expect-error Untyped input bypasses the record-label schema.
      Taxonomy.classifyRecords([" "], taxon),
      // @ts-expect-error Untyped input supplies a malformed expression.
      Taxonomy.classifyRecords([RecordLabel.make("subject")], malformed),
    ];
    for (const operation of invalid) {
      const failure = yield* Effect.flip(operation);
      expect(failure.reason._tag).toBe("InvalidUserInputError");
    }
  }).pipe(Effect.provide(layer));
});
