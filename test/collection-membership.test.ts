import { expect, it } from "@effect/vitest";
import { Array, Cause, Deferred, Effect, Exit, Fiber, Layer, Option, Record } from "effect";
import { AiError, DecisionModel } from "effect/ai";
import {
  CollectionExecution,
  JudgmentPolicy,
  RecordLabel,
  TaxonomicRecord,
  TaxonName,
  Taxonomy,
  TaxonSet,
  type CollectionMembershipResult,
} from "../src/index.ts";

// Supplied answers exercise collection behavior, not biological accuracy.
it.effect(
  "partitions original occurrences into five ordered buckets and retains caller fields",
  () => {
    const member = { scientificName: TaxonName.make("A"), sampleId: "member" };
    const outside = { scientificName: TaxonName.make("B"), sampleId: "outside" };
    const mixed = { scientificName: TaxonName.make("A and B"), sampleId: "mixed" };
    const unresolved = {
      ...TaxonomicRecord.make({ scientificName: TaxonName.make("?") }),
      sampleId: "unresolved",
    };
    const diagnosed = { scientificName: TaxonName.make("C"), sampleId: "diagnosed" };
    const target = TaxonName.make("A and C");
    let calls = 0;
    const layer = Layer.effect(
      DecisionModel.DecisionModel,
      DecisionModel.make({
        decide: ({ state, decisions }) => {
          calls++;
          expect(state).toBe(target);
          expect(Object.keys(decisions)).toEqual([
            "record0",
            "record1",
            "record2",
            "record3",
            "record4",
            "record5",
          ]);
          const answer = (label: string) => ({
            _tag: "Classify" as const,
            label,
            probabilities: {
              member: 0,
              notMember: 0,
              mixed: 0,
              undetermined: 0,
              multipleTarget0: 0,
              [label]: 1,
            },
          });
          return Effect.succeed({
            answers: {
              record0: answer("member"),
              record1: answer("notMember"),
              record2: answer("mixed"),
              record3: answer("undetermined"),
              record4: answer("multipleTarget0"),
              record5: answer("member"),
            },
            usage: { inputTokens: undefined, outputTokens: undefined },
          });
        },
      }),
    );
    return Effect.gen(function* () {
      const partition = yield* Taxonomy.partitionRecordsByMembership(
        [member, outside, mixed, unresolved, diagnosed, member],
        target,
      );
      expect(partition.Member).toEqual([member, member]);
      expect(partition.Member[0]).toBe(member);
      expect(partition.Member[1]).toBe(member);
      expect(partition.NotMember[0]).toBe(outside);
      expect(partition.MixedMembership[0]).toBe(mixed);
      expect(partition.Undetermined[0]).toBe(unresolved);
      expect(partition.MultipleTaxaInTargetName).toEqual([
        { record: diagnosed, targetName: target },
      ]);
      expect(partition.MultipleTaxaInTargetName[0]?.record).toBe(diagnosed);
      expect(partition.pipe((value) => value.Member.map((record) => record.sampleId))).toEqual([
        "member",
        "member",
      ]);
      expect(calls).toBe(1);
    }).pipe(Effect.provide(layer));
  },
);

it.effect("keeps overlapping genus/family groups and repeated targets in supplied order", () => {
  const record = { scientificName: TaxonName.make("Quercus robur"), sampleId: "A17" };
  const genus = TaxonName.make("Quercus");
  const family = TaxonName.make("Fagaceae");
  const seen: string[] = [];
  const layer = Layer.effect(
    DecisionModel.DecisionModel,
    DecisionModel.make({
      decide: ({ state }) => {
        if (typeof state !== "string") return Effect.die("Expected named target");
        seen.push(state);
        return Effect.succeed({
          answers: {
            record0: {
              _tag: "Classify",
              label: "member",
              probabilities: {
                member: 1,
                notMember: 0,
                mixed: 0,
                undetermined: 0,
                multipleTarget0: 0,
              },
            },
          },
          usage: { inputTokens: undefined, outputTokens: undefined },
        });
      },
    }),
  );
  return Effect.gen(function* () {
    const grouped = yield* Taxonomy.groupRecordsByTaxa([record], [genus, family, genus]);
    expect(grouped.groups.map((group) => group.target)).toEqual([genus, family, genus]);
    expect(seen).toEqual([genus, family, genus]);
    expect(
      grouped.pipe((value) =>
        value.groups.map((group) =>
          group.partition.pipe((partition) => partition.Member[0]?.sampleId),
        ),
      ),
    ).toEqual(["A17", "A17", "A17"]);
    for (const group of grouped.groups) expect(group.partition.Member[0]).toBe(record);
    expect(grouped.groups[0]?.partition).not.toBe(grouped.groups[2]?.partition);
  }).pipe(Effect.provide(layer));
});

it.effect(
  "quantifies whole records in windows, remembering uncertainty and stopping at the first terminal",
  () => {
    let calls = 0;
    const layer = Layer.effect(
      DecisionModel.DecisionModel,
      DecisionModel.make({
        decide: () => {
          calls++;
          return Effect.succeed({
            answers: {
              record0: membershipAnswer("undetermined"),
              record1: membershipAnswer("mixed"),
            },
            usage: { inputTokens: undefined, outputTokens: undefined },
          });
        },
      }),
    );
    return Effect.gen(function* () {
      const records = [
        RecordLabel.make("uncertain"),
        RecordLabel.make("mixed"),
        RecordLabel.make("unrequested"),
      ];
      expect(
        yield* Taxonomy.allRecordsBelongTo(records, TaxonName.make("A"), {
          execution: CollectionExecution.make({ batchSize: 2, concurrency: 1 }),
        }),
      ).toEqual({ _tag: "No", quantifier: "all" });
      expect(calls).toBe(1);
    }).pipe(Effect.provide(layer));
  },
);

const membershipAnswer = (label: string): DecisionModel.ProviderClassifyAnswer => ({
  _tag: "Classify",
  label,
  probabilities: {
    member: 0,
    notMember: 0,
    mixed: 0,
    undetermined: 0,
    multipleTarget0: 0,
    [label]: 1,
  },
});

const response = (labels: readonly string[]): DecisionModel.ProviderResponse => ({
  answers: Record.fromEntries(
    labels.map((label, index) => [`record${index}`, membershipAnswer(label)] as const),
  ),
  usage: { inputTokens: undefined, outputTokens: undefined },
});

const target = TaxonName.make("A and B");
const records = [
  RecordLabel.make("first"),
  RecordLabel.make("second"),
  RecordLabel.make("third"),
  RecordLabel.make("fourth"),
] as const;
const quantifiers = [
  ["all", Taxonomy.allRecordsBelongTo],
  ["any", Taxonomy.anyRecordBelongsTo],
  ["none", Taxonomy.noRecordBelongsTo],
] as const;

it.effect.each(quantifiers)(
  "uses no calls for %s empty inputs and literal Empty targets",
  ([quantifier, operation]) => {
    const layer = Layer.effect(
      DecisionModel.DecisionModel,
      DecisionModel.make({ decide: () => Effect.die("Unexpected request") }),
    );
    return Effect.gen(function* () {
      expect(yield* operation([], target)).toEqual({
        _tag: quantifier === "any" ? "No" : "Yes",
        quantifier,
      });
      expect(yield* operation([], TaxonSet.empty())).toEqual({
        _tag: quantifier === "any" ? "No" : "Yes",
        quantifier,
      });
      expect(yield* operation(records, TaxonSet.empty())).toEqual({
        _tag: quantifier === "none" ? "Yes" : "No",
        quantifier,
      });
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "returns fresh empty partitions/groups and preserves Empty-target occurrences without calls",
  () => {
    const layer = Layer.effect(
      DecisionModel.DecisionModel,
      DecisionModel.make({ decide: () => Effect.die("Unexpected request") }),
    );
    return Effect.gen(function* () {
      const empty = Taxonomy.partitionRecordsByMembership([], target);
      const first = yield* empty;
      const second = yield* empty;
      expect(first).toEqual({
        Member: [],
        NotMember: [],
        MixedMembership: [],
        Undetermined: [],
        MultipleTaxaInTargetName: [],
      });
      expect(first).not.toBe(second);
      expect(first.Member).not.toBe(second.Member);
      expect(first.NotMember).not.toBe(second.NotMember);
      expect(first.MixedMembership).not.toBe(second.MixedMembership);
      expect(first.Undetermined).not.toBe(second.Undetermined);
      expect(first.MultipleTaxaInTargetName).not.toBe(second.MultipleTaxaInTargetName);
      const partition = yield* Taxonomy.partitionRecordsByMembership(
        [records[0], records[0]],
        TaxonSet.empty(),
      );
      expect(partition.NotMember).toEqual([records[0], records[0]]);
      expect(partition.Member).toEqual([]);
      expect(yield* Taxonomy.groupRecordsByTaxa(records, [])).toMatchObject({ groups: [] });
      const grouped = yield* Taxonomy.groupRecordsByTaxa([], [target, target]);
      expect(grouped.groups).toHaveLength(2);
      expect(grouped.groups[0]?.partition).toEqual(first);
      expect(grouped.groups[0]?.partition).not.toBe(grouped.groups[1]?.partition);
      expect(
        grouped.pipe((value) => value.groups[0]?.partition.pipe((value) => value.Member)),
      ).toEqual([]);
      const emptyTargets = yield* Taxonomy.groupRecordsByTaxa(records, [TaxonSet.empty()]);
      expect(emptyTargets.groups[0]?.partition.NotMember).toEqual(records);
    }).pipe(Effect.provide(layer));
  },
);

it.effect("reconstructs partitions in input order after batches finish in reverse order", () =>
  Effect.gen(function* () {
    const firstStarted = yield* Deferred.make<void>();
    const secondStarted = yield* Deferred.make<void>();
    const thirdStarted = yield* Deferred.make<void>();
    const firstRelease = yield* Deferred.make<void>();
    const secondRelease = yield* Deferred.make<void>();
    const thirdRelease = yield* Deferred.make<void>();
    const thirdCompleted = yield* Deferred.make<void>();
    let calls = 0;
    let active = 0;
    let maximum = 0;
    const completed: number[] = [];
    const layer = Layer.effect(
      DecisionModel.DecisionModel,
      DecisionModel.make({
        decide: () =>
          Effect.gen(function* () {
            const index = calls++;
            active++;
            maximum = Math.max(maximum, active);
            const slot = Array.get(
              [
                { started: firstStarted, release: firstRelease, labels: ["member", "notMember"] },
                {
                  started: secondStarted,
                  release: secondRelease,
                  labels: ["member", "multipleTarget0"],
                },
                { started: thirdStarted, release: thirdRelease, labels: ["mixed", "member"] },
              ],
              index,
            ).pipe(Option.getOrThrow);
            yield* Deferred.succeed(slot.started, undefined);
            yield* Deferred.await(slot.release);
            completed.push(index);
            active--;
            if (index === 2) yield* Deferred.succeed(thirdCompleted, undefined);
            return response(slot.labels);
          }),
      }),
    );
    const repeated = { scientificName: TaxonName.make("A"), sampleId: "repeat" };
    const outside = { scientificName: TaxonName.make("B"), sampleId: "outside" };
    const diagnosed = { scientificName: TaxonName.make("C"), sampleId: "diagnosed" };
    const mixed = { scientificName: TaxonName.make("D"), sampleId: "mixed" };
    const last = { scientificName: TaxonName.make("E"), sampleId: "last" };
    const fiber = yield* Taxonomy.partitionRecordsByMembership(
      [repeated, outside, repeated, diagnosed, mixed, last],
      target,
      {
        execution: CollectionExecution.make({ batchSize: 2, concurrency: 2 }),
      },
    ).pipe(Effect.provide(layer), Effect.forkChild);
    yield* Deferred.await(firstStarted);
    yield* Deferred.await(secondStarted);
    expect(calls).toBe(2);
    yield* Deferred.succeed(secondRelease, undefined);
    yield* Deferred.await(thirdStarted);
    yield* Deferred.succeed(thirdRelease, undefined);
    yield* Deferred.await(thirdCompleted);
    yield* Deferred.succeed(firstRelease, undefined);
    const partition = yield* Fiber.join(fiber);
    expect(maximum).toBe(2);
    expect(completed).toEqual([1, 2, 0]);
    expect(partition.Member.map((record) => record.sampleId)).toEqual(["repeat", "repeat", "last"]);
    expect(partition.Member[0]).toBe(repeated);
    expect(partition.Member[1]).toBe(repeated);
    expect(partition.Member[2]).toBe(last);
    expect(partition.NotMember[0]).toBe(outside);
    expect(partition.MixedMembership[0]).toBe(mixed);
    expect(partition.MultipleTaxaInTargetName[0]?.record).toBe(diagnosed);
  }),
);

it.effect.each(quantifiers)(
  "awaits a successful %s window then scans input order despite reversed completion",
  ([quantifier, operation]) =>
    Effect.gen(function* () {
      const bothStarted = yield* Deferred.make<void>();
      const secondCompleted = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      let calls = 0;
      let settled = false;
      const layer = Layer.effect(
        DecisionModel.DecisionModel,
        DecisionModel.make({
          decide: () =>
            Effect.gen(function* () {
              const index = calls++;
              if (index === 1) yield* Deferred.succeed(bothStarted, undefined);
              yield* Deferred.await(bothStarted);
              if (index === 0) {
                yield* Deferred.await(releaseFirst);
                return response([quantifier === "all" ? "notMember" : "member"]);
              }
              yield* Deferred.succeed(secondCompleted, undefined);
              return response(["multipleTarget0"]);
            }),
        }),
      );
      const fiber = yield* operation(records, target, {
        execution: CollectionExecution.make({ batchSize: 1, concurrency: 2 }),
      }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            settled = true;
          }),
        ),
        Effect.provide(layer),
        Effect.forkChild,
      );
      yield* Deferred.await(secondCompleted);
      expect(settled).toBe(false);
      expect(calls).toBe(2);
      yield* Deferred.succeed(releaseFirst, undefined);
      const result: CollectionMembershipResult = yield* Fiber.join(fiber);
      expect(result).toEqual({ _tag: quantifier === "any" ? "Yes" : "No", quantifier });
      expect(calls).toBe(2);
    }),
);

it.effect.each(quantifiers)(
  "remembers %s uncertainty across windows without inventing a terminal answer",
  ([quantifier, operation]) => {
    let calls = 0;
    const layer = Layer.effect(
      DecisionModel.DecisionModel,
      DecisionModel.make({
        decide: () =>
          Effect.succeed(
            response([calls++ === 0 ? "undetermined" : quantifier === "all" ? "member" : "mixed"]),
          ),
      }),
    );
    return Effect.gen(function* () {
      expect(
        yield* operation(records, target, {
          execution: CollectionExecution.make({ batchSize: 1, concurrency: 1 }),
        }),
      ).toEqual({ _tag: "Undetermined", quantifier });
      expect(calls).toBe(4);
    }).pipe(Effect.provide(layer));
  },
);

it.effect("bounds grouping batches without multiplying the cap across sequential targets", () =>
  Effect.gen(function* () {
    const firstWindowStarted = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let calls = 0;
    let active = 0;
    let maximum = 0;
    const seen: string[] = [];
    const layer = Layer.effect(
      DecisionModel.DecisionModel,
      DecisionModel.make({
        decide: ({ state, decisions }) =>
          Effect.gen(function* () {
            if (typeof state !== "string") return yield* Effect.die("Expected named target");
            calls++;
            active++;
            maximum = Math.max(maximum, active);
            seen.push(state);
            expect(Object.keys(decisions)).toEqual(["record0"]);
            if (calls === 2) yield* Deferred.succeed(firstWindowStarted, undefined);
            yield* Deferred.await(release);
            active--;
            return response(["member"]);
          }),
      }),
    );
    const fiber = yield* Taxonomy.groupRecordsByTaxa(
      records,
      [TaxonName.make("genus"), TaxonName.make("family")],
      {
        execution: CollectionExecution.make({ batchSize: 1, concurrency: 2 }),
      },
    ).pipe(Effect.provide(layer), Effect.forkChild);
    yield* Deferred.await(firstWindowStarted);
    expect(seen).toEqual(["genus", "genus"]);
    expect(active).toBe(2);
    yield* Deferred.succeed(release, undefined);
    const grouped = yield* Fiber.join(fiber);
    expect(maximum).toBe(2);
    expect(seen).toEqual([
      "genus",
      "genus",
      "genus",
      "genus",
      "family",
      "family",
      "family",
      "family",
    ]);
    expect(grouped.groups[0]?.partition.Member).toEqual(records);
    expect(grouped.groups[1]?.partition.Member).toEqual(records);
  }),
);

it.effect("gives independent public operations independent concurrency bounds", () =>
  Effect.gen(function* () {
    const bothStarted = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let active = 0;
    let calls = 0;
    let maximum = 0;
    const layer = Layer.effect(
      DecisionModel.DecisionModel,
      DecisionModel.make({
        decide: () =>
          Effect.gen(function* () {
            calls++;
            active++;
            maximum = Math.max(maximum, active);
            if (calls === 2) yield* Deferred.succeed(bothStarted, undefined);
            yield* Deferred.await(release);
            active--;
            return response(["member"]);
          }),
      }),
    );
    const execution = CollectionExecution.make({ batchSize: 1, concurrency: 1 });
    const fiber = yield* Effect.all(
      [
        Taxonomy.partitionRecordsByMembership(records.slice(0, 2), target, { execution }),
        Taxonomy.groupRecordsByTaxa(records.slice(0, 2), [target], { execution }),
      ],
      { concurrency: 2 },
    ).pipe(Effect.provide(layer), Effect.forkChild);
    yield* Deferred.await(bothStarted);
    expect(active).toBe(2);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(fiber);
    expect(maximum).toBe(2);
    expect(calls).toBe(4);
  }),
);

const operations = [
  [
    "partition",
    (execution: CollectionExecution) =>
      Taxonomy.partitionRecordsByMembership(records.slice(0, 2), target, { execution }).pipe(
        Effect.asVoid,
      ),
  ],
  [
    "group",
    (execution: CollectionExecution) =>
      Taxonomy.groupRecordsByTaxa(
        records.slice(0, 2),
        [target, TaxonName.make("unrequested target")],
        { execution },
      ).pipe(Effect.asVoid),
  ],
  [
    "all",
    (execution: CollectionExecution) =>
      Taxonomy.allRecordsBelongTo(records, target, { execution }).pipe(Effect.asVoid),
  ],
  [
    "any",
    (execution: CollectionExecution) =>
      Taxonomy.anyRecordBelongsTo(records, target, { execution }).pipe(Effect.asVoid),
  ],
  [
    "none",
    (execution: CollectionExecution) =>
      Taxonomy.noRecordBelongsTo(records, target, { execution }).pipe(Effect.asVoid),
  ],
] as const;

it.effect.each(operations)(
  "fails %s on any invalid/failed current batch, even beside a decisive answer",
  ([kind, operation]) =>
    Effect.gen(function* () {
      const failure = AiError.make({
        module: "TestProvider",
        method: "decide",
        reason: new AiError.UnknownError({ description: "unavailable" }),
      });
      for (const mode of ["missing", "invalid", "failure"] as const) {
        const firstAnswered = yield* Deferred.make<void>();
        let calls = 0;
        let succeeded = false;
        const layer = Layer.effect(
          DecisionModel.DecisionModel,
          DecisionModel.make({
            decide: () =>
              Effect.gen(function* () {
                const index = calls++;
                if (index === 0) {
                  yield* Deferred.succeed(firstAnswered, undefined);
                  return response([kind === "all" ? "notMember" : "member"]);
                }
                yield* Deferred.await(firstAnswered);
                if (mode === "failure") return yield* failure;
                return mode === "missing"
                  ? response([])
                  : {
                      answers: {
                        record0: {
                          _tag: "Classify",
                          label: "invented",
                          probabilities: { invented: 1 },
                        },
                      },
                      usage: { inputTokens: undefined, outputTokens: undefined },
                    };
              }),
          }),
        );
        const error = yield* operation(
          CollectionExecution.make({ batchSize: 1, concurrency: 2 }),
        ).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              succeeded = true;
            }),
          ),
          Effect.provide(layer),
          Effect.flip,
        );
        expect(error.reason._tag).toBe(mode === "failure" ? "UnknownError" : "InvalidOutputError");
        if (mode === "failure") expect(error).toBe(failure);
        expect(succeeded).toBe(false);
        expect(calls).toBe(2);
      }
    }),
);

it.effect.each(operations)(
  "interrupts %s in-flight work without success, retry, or later windows/targets",
  ([_kind, operation]) =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      let calls = 0;
      let interrupted = 0;
      let succeeded = false;
      const layer = Layer.effect(
        DecisionModel.DecisionModel,
        DecisionModel.make({
          decide: () => {
            calls++;
            return Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() =>
                Effect.sync(() => {
                  interrupted++;
                }),
              ),
            );
          },
        }),
      );
      const fiber = yield* operation(
        CollectionExecution.make({ batchSize: 1, concurrency: 1 }),
      ).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            succeeded = true;
          }),
        ),
        Effect.provide(layer),
        Effect.forkChild,
      );
      yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);
      const exit = yield* Fiber.await(fiber);
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
      expect(succeeded).toBe(false);
      expect(calls).toBe(1);
      expect(interrupted).toBe(1);
    }),
);

it.effect.each(operations)(
  "preserves %s defects instead of returning partial or uncertain success",
  ([_kind, operation]) => {
    const defect = new Error("Provider defect");
    let calls = 0;
    let succeeded = false;
    const layer = Layer.effect(
      DecisionModel.DecisionModel,
      DecisionModel.make({
        decide: () => {
          calls++;
          return calls === 1 ? Effect.succeed(response(["undetermined"])) : Effect.die(defect);
        },
      }),
    );
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        operation(CollectionExecution.make({ batchSize: 1, concurrency: 1 })).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              succeeded = true;
            }),
          ),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit))
        expect(exit.cause.reasons.filter(Cause.isDieReason).map((reason) => reason.defect)).toEqual(
          [defect],
        );
      expect(calls).toBe(2);
      expect(succeeded).toBe(false);
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "keeps a shared encoded expression and original-name mapping for every batch answer",
  () => {
    const firstName = TaxonName.make("A");
    const problemName = TaxonName.make('B and "C"');
    const expression = TaxonSet.union(TaxonSet.of(firstName), TaxonSet.of(problemName));
    const first = { label: RecordLabel.make('voucher "one"\nline'), sampleId: "one" };
    const second = { scientificName: TaxonName.make("second name"), sampleId: "two" };
    const layer = Layer.effect(
      DecisionModel.DecisionModel,
      DecisionModel.make({
        decide: ({ state, decisions }) => {
          expect(state).toEqual({
            _tag: "Union",
            operands: [
              { _tag: "Taxon", name: "A" },
              { _tag: "Taxon", name: 'B and "C"' },
            ],
          });
          expect(Object.keys(decisions)).toEqual(["record0", "record1"]);
          expect(decisions.record0).toMatchObject({
            instructions:
              'Classify this record\'s membership in the supplied taxon or taxon-set expression.\nRecord label: "voucher \\"one\\"\\nline"',
          });
          expect(decisions.record1).toMatchObject({
            instructions:
              'Classify this record\'s membership in the supplied taxon or taxon-set expression.\nScientific name: "second name"',
          });
          return Effect.succeed({
            answers: {
              record0: {
                _tag: "Classify",
                label: "multipleTarget1",
                probabilities: {
                  member: 0,
                  notMember: 0,
                  mixed: 0,
                  undetermined: 0,
                  multipleTarget0: 0,
                  multipleTarget1: 1,
                },
              },
              record1: {
                _tag: "Classify",
                label: "member",
                probabilities: {
                  member: 0.6,
                  notMember: 0,
                  mixed: 0,
                  undetermined: 0,
                  multipleTarget0: 0.4,
                  multipleTarget1: 0,
                },
              },
            },
            usage: { inputTokens: undefined, outputTokens: undefined },
          });
        },
      }),
    );
    return Effect.gen(function* () {
      const partition = yield* Taxonomy.partitionRecordsByMembership([first, second], expression, {
        policy: JudgmentPolicy.make({ minimumSupport: 0.8, minimumMargin: 0 }),
      });
      expect(partition.MultipleTaxaInTargetName).toEqual([
        { record: first, targetName: problemName },
      ]);
      expect(partition.MultipleTaxaInTargetName[0]?.record).toBe(first);
      expect(partition.Undetermined[0]).toBe(second);
      expect(partition.Member).toEqual([]);
    }).pipe(Effect.provide(layer));
  },
);

it.effect.each(quantifiers)(
  "stops %s after an ordered diagnosis, without launching another window",
  ([quantifier, operation]) => {
    let calls = 0;
    const layer = Layer.effect(
      DecisionModel.DecisionModel,
      DecisionModel.make({
        decide: () => {
          calls++;
          return Effect.succeed(response(["multipleTarget0"]));
        },
      }),
    );
    return Effect.gen(function* () {
      expect(
        yield* operation(records, target, {
          execution: CollectionExecution.make({ batchSize: 1, concurrency: 1 }),
        }),
      ).toEqual({ _tag: "MultipleTaxaInTargetName", quantifier, targetName: target });
      expect(calls).toBe(1);
    }).pipe(Effect.provide(layer));
  },
);

it.effect.each(quantifiers)(
  "threads %s policy through successive windows and accepts later decisive answers",
  ([quantifier, operation]) => {
    let calls = 0;
    const layer = Layer.effect(
      DecisionModel.DecisionModel,
      DecisionModel.make({
        decide: () => {
          calls++;
          return Effect.succeed(
            calls === 1
              ? {
                  answers: {
                    record0: {
                      _tag: "Classify",
                      label: "multipleTarget0",
                      probabilities: {
                        member: 0.4,
                        notMember: 0,
                        mixed: 0,
                        undetermined: 0,
                        multipleTarget0: 0.6,
                      },
                    },
                  },
                  usage: { inputTokens: undefined, outputTokens: undefined },
                }
              : response([quantifier === "all" ? "mixed" : "member"]),
          );
        },
      }),
    );
    return Effect.gen(function* () {
      expect(
        yield* operation(records, target, {
          policy: JudgmentPolicy.make({ minimumSupport: 0.8, minimumMargin: 0 }),
          execution: CollectionExecution.make({ batchSize: 1, concurrency: 1 }),
        }),
      ).toEqual({ _tag: quantifier === "any" ? "Yes" : "No", quantifier });
      expect(calls).toBe(2);
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "retains each target's mixed, uncertain, and diagnosed records beside another group's membership",
  () => {
    let calls = 0;
    const layer = Layer.effect(
      DecisionModel.DecisionModel,
      DecisionModel.make({
        decide: () => {
          calls++;
          return Effect.succeed(
            calls === 1
              ? response(["member", "member", "member"])
              : response(["mixed", "undetermined", "multipleTarget0"]),
          );
        },
      }),
    );
    return Effect.gen(function* () {
      const grouped = yield* Taxonomy.groupRecordsByTaxa(records.slice(0, 3), [
        target,
        TaxonName.make("other"),
      ]);
      expect(grouped.groups[0]?.partition.Member).toEqual(records.slice(0, 3));
      expect(grouped.groups[1]?.partition.MixedMembership).toEqual([records[0]]);
      expect(grouped.groups[1]?.partition.Undetermined).toEqual([records[1]]);
      expect(grouped.groups[1]?.partition.MultipleTaxaInTargetName).toEqual([
        { record: records[2], targetName: "other" },
      ]);
      expect(calls).toBe(2);
    }).pipe(Effect.provide(layer));
  },
);

it.effect("threads grouping policy without sharing or caching repeated executions", () => {
  let calls = 0;
  const layer = Layer.effect(
    DecisionModel.DecisionModel,
    DecisionModel.make({
      decide: () => {
        calls++;
        return Effect.succeed({
          answers: {
            record0: {
              _tag: "Classify",
              label: "member",
              probabilities: {
                member: 0.7,
                notMember: 0.3,
                mixed: 0,
                undetermined: 0,
                multipleTarget0: 0,
              },
            },
          },
          usage: { inputTokens: undefined, outputTokens: undefined },
        });
      },
    }),
  );
  return Effect.gen(function* () {
    const program = Taxonomy.groupRecordsByTaxa([records[0]], [target], {
      policy: JudgmentPolicy.make({ minimumSupport: 0.8, minimumMargin: 0 }),
    });
    const first = yield* program;
    const second = yield* program;
    expect(first.groups[0]?.partition.Undetermined).toEqual([records[0]]);
    expect(second.groups[0]?.partition.Undetermined).toEqual([records[0]]);
    expect(second).not.toBe(first);
    expect(second.groups).not.toBe(first.groups);
    expect(second.groups[0]?.partition).not.toBe(first.groups[0]?.partition);
    expect(calls).toBe(2);
  }).pipe(Effect.provide(layer));
});

it.effect(
  "fails grouping after a complete earlier target without returning partial groups or starting later targets",
  () => {
    const failure = AiError.make({
      module: "TestProvider",
      method: "decide",
      reason: new AiError.UnknownError({ description: "second target failed" }),
    });
    const seen: string[] = [];
    let succeeded = false;
    const layer = Layer.effect(
      DecisionModel.DecisionModel,
      DecisionModel.make({
        decide: ({ state }) => {
          if (typeof state !== "string") return Effect.die("Expected named target");
          seen.push(state);
          return state === "second" ? Effect.fail(failure) : Effect.succeed(response(["member"]));
        },
      }),
    );
    return Effect.gen(function* () {
      const error = yield* Taxonomy.groupRecordsByTaxa(
        [records[0]],
        [TaxonName.make("first"), TaxonName.make("second"), TaxonName.make("unrequested")],
      ).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            succeeded = true;
          }),
        ),
        Effect.flip,
      );
      expect(error).toBe(failure);
      expect(seen).toEqual(["first", "second"]);
      expect(succeeded).toBe(false);
    }).pipe(Effect.provide(layer));
  },
);

it.effect("interrupts sibling batches on a window failure and launches no later window", () =>
  Effect.gen(function* () {
    const bothStarted = yield* Deferred.make<void>();
    const failure = AiError.make({
      module: "TestProvider",
      method: "decide",
      reason: new AiError.UnknownError({ description: "failed window" }),
    });
    let calls = 0;
    let interrupted = 0;
    const layer = Layer.effect(
      DecisionModel.DecisionModel,
      DecisionModel.make({
        decide: () =>
          Effect.gen(function* () {
            const index = calls++;
            if (index === 1) yield* Deferred.succeed(bothStarted, undefined);
            yield* Deferred.await(bothStarted);
            if (index === 0) return yield* failure;
            return yield* Effect.never.pipe(
              Effect.onInterrupt(() =>
                Effect.sync(() => {
                  interrupted++;
                }),
              ),
            );
          }),
      }),
    );
    expect(
      yield* Effect.flip(
        Taxonomy.anyRecordBelongsTo(records, target, {
          execution: CollectionExecution.make({ batchSize: 1, concurrency: 2 }),
        }).pipe(Effect.provide(layer)),
      ),
    ).toBe(failure);
    expect(calls).toBe(2);
    expect(interrupted).toBe(1);
  }),
);

const defaultOperations = [
  [
    "partition",
    (input: readonly RecordLabel[]) =>
      Taxonomy.partitionRecordsByMembership(input, target).pipe(Effect.asVoid),
  ],
  [
    "group",
    (input: readonly RecordLabel[]) =>
      Taxonomy.groupRecordsByTaxa(input, [target]).pipe(Effect.asVoid),
  ],
  [
    "all",
    (input: readonly RecordLabel[]) =>
      Taxonomy.allRecordsBelongTo(input, target).pipe(Effect.asVoid),
  ],
  [
    "any",
    (input: readonly RecordLabel[]) =>
      Taxonomy.anyRecordBelongsTo(input, target).pipe(Effect.asVoid),
  ],
  [
    "none",
    (input: readonly RecordLabel[]) =>
      Taxonomy.noRecordBelongsTo(input, target).pipe(Effect.asVoid),
  ],
] as const;

it.effect.each(defaultOperations)(
  "defaults %s to 16 records per batch and one in-flight call",
  ([kind, operation]) =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let active = 0;
      let maximum = 0;
      const sizes: number[] = [];
      const layer = Layer.effect(
        DecisionModel.DecisionModel,
        DecisionModel.make({
          decide: ({ decisions }) =>
            Effect.gen(function* () {
              active++;
              maximum = Math.max(maximum, active);
              sizes.push(Object.keys(decisions).length);
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(release);
              active--;
              return response(
                Array.replicate(
                  kind === "any" || kind === "none" ? "notMember" : "member",
                  Object.keys(decisions).length,
                ),
              );
            }),
        }),
      );
      const fiber = yield* operation(Array.replicate(records[0], 33)).pipe(
        Effect.provide(layer),
        Effect.forkChild,
      );
      yield* Deferred.await(started);
      expect(sizes).toEqual([16]);
      expect(active).toBe(1);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(fiber);
      expect(sizes).toEqual([16, 16, 1]);
      expect(maximum).toBe(1);
    }),
);

it.effect("does not turn nonliteral empty expressions into collection shortcuts", () => {
  let calls = 0;
  const expression = TaxonSet.difference(TaxonSet.empty(), TaxonSet.empty());
  const layer = Layer.effect(
    DecisionModel.DecisionModel,
    DecisionModel.make({
      decide: ({ state }) => {
        calls++;
        expect(state).toEqual({
          _tag: "Difference",
          left: { _tag: "Empty" },
          right: { _tag: "Empty" },
        });
        return Effect.succeed({
          answers: {
            record0: {
              _tag: "Classify",
              label: "undetermined",
              probabilities: { member: 0, notMember: 0, mixed: 0, undetermined: 1 },
            },
          },
          usage: { inputTokens: undefined, outputTokens: undefined },
        });
      },
    }),
  );
  return Effect.gen(function* () {
    const partition = yield* Taxonomy.partitionRecordsByMembership([records[0]], expression);
    expect(partition.Undetermined).toEqual([records[0]]);
    expect(yield* Taxonomy.anyRecordBelongsTo([records[0]], expression)).toEqual({
      _tag: "Undetermined",
      quantifier: "any",
    });
    expect(calls).toBe(2);
  }).pipe(Effect.provide(layer));
});

it.effect("rejects invalid original records/targets before transporting their batch", () => {
  const layer = Layer.effect(
    DecisionModel.DecisionModel,
    DecisionModel.make({ decide: () => Effect.die("Unexpected transport") }),
  );
  return Effect.gen(function* () {
    const invalidRecords = [
      // @ts-expect-error Untyped caller supplies a record without facts.
      Taxonomy.partitionRecordsByMembership([{}], target).pipe(Effect.asVoid),
      // @ts-expect-error Untyped caller supplies a blank target name.
      Taxonomy.groupRecordsByTaxa(records, [" "]).pipe(Effect.asVoid),
      // @ts-expect-error Untyped caller supplies a malformed recursive target.
      Taxonomy.allRecordsBelongTo(records, { _tag: "Difference", left: TaxonSet.empty() }).pipe(
        Effect.asVoid,
      ),
      // @ts-expect-error Untyped caller supplies an invalid record.
      Taxonomy.anyRecordBelongsTo([42], target).pipe(Effect.asVoid),
      // @ts-expect-error Untyped caller supplies a blank record label.
      Taxonomy.noRecordBelongsTo([" "], target).pipe(Effect.asVoid),
    ];
    for (const operation of invalidRecords)
      expect((yield* Effect.flip(operation)).reason._tag).toBe("InvalidUserInputError");
  }).pipe(Effect.provide(layer));
});

it.each([0, -1, 1.5, Infinity, NaN])("rejects invalid collection execution bound %s", (value) => {
  expect(() => CollectionExecution.make({ batchSize: value, concurrency: 1 })).toThrow();
  expect(() => CollectionExecution.make({ batchSize: 1, concurrency: value })).toThrow();
});

it.effect.each([
  ["all", ["member", "member"], { _tag: "Yes", quantifier: "all" }],
  ["all", ["member", "notMember"], { _tag: "No", quantifier: "all" }],
  ["all", ["member", "mixed"], { _tag: "No", quantifier: "all" }],
  ["all", ["undetermined", "member"], { _tag: "Undetermined", quantifier: "all" }],
  ["any", ["notMember", "mixed"], { _tag: "No", quantifier: "any" }],
  ["any", ["undetermined", "member"], { _tag: "Yes", quantifier: "any" }],
  ["any", ["mixed", "undetermined"], { _tag: "Undetermined", quantifier: "any" }],
  ["none", ["mixed", "notMember"], { _tag: "Yes", quantifier: "none" }],
  ["none", ["undetermined", "member"], { _tag: "No", quantifier: "none" }],
  ["none", ["undetermined", "mixed"], { _tag: "Undetermined", quantifier: "none" }],
] as const)("maps %s whole-record fixture %s", ([quantifier, labels, expected]) => {
  const operation = quantifiers.find(([kind]) => kind === quantifier)?.[1];
  if (operation === undefined) return Effect.die("Missing operation");
  return Effect.gen(function* () {
    expect(yield* operation(records.slice(0, 2), target)).toEqual(expected);
  }).pipe(
    Effect.provide(
      Layer.effect(
        DecisionModel.DecisionModel,
        DecisionModel.make({ decide: () => Effect.succeed(response(labels)) }),
      ),
    ),
  );
});

it.effect.each(quantifiers)(
  "scans %s diagnoses in record order, without global diagnosis precedence",
  ([quantifier, operation]) =>
    Effect.gen(function* () {
      const decisive = quantifier === "all" ? "mixed" : "member";
      for (const [labels, expected] of [
        [
          ["undetermined", decisive, "multipleTarget0"],
          { _tag: quantifier === "any" ? "Yes" : "No", quantifier },
        ],
        [
          ["undetermined", "multipleTarget0", decisive],
          { _tag: "MultipleTaxaInTargetName", quantifier, targetName: target },
        ],
      ] as const) {
        const layer = Layer.effect(
          DecisionModel.DecisionModel,
          DecisionModel.make({ decide: () => Effect.succeed(response(labels)) }),
        );
        expect(yield* operation(records.slice(0, 3), target).pipe(Effect.provide(layer))).toEqual(
          expected,
        );
      }
    }),
);

it.effect("uses default batches of 16 and independently applies policy to each answer", () => {
  const sizes: number[] = [];
  const layer = Layer.effect(
    DecisionModel.DecisionModel,
    DecisionModel.make({
      decide: ({ decisions }) => {
        sizes.push(Object.keys(decisions).length);
        return Effect.succeed({
          answers: Record.fromEntries(
            Object.keys(decisions).map(
              (key) =>
                [
                  key,
                  {
                    _tag: "Classify" as const,
                    label: "member",
                    probabilities: {
                      member: 0.75,
                      notMember: 0.25,
                      mixed: 0,
                      undetermined: 0,
                      multipleTarget0: 0,
                    },
                  },
                ] as const,
            ),
          ),
          usage: { inputTokens: undefined, outputTokens: undefined },
        });
      },
    }),
  );
  return Effect.gen(function* () {
    const repeated = Array.replicate(RecordLabel.make("same occurrence text"), 35);
    const partition = yield* Taxonomy.partitionRecordsByMembership(repeated, target, {
      policy: JudgmentPolicy.make({ minimumSupport: 0.8, minimumMargin: 0 }),
    });
    expect(sizes).toEqual([16, 16, 3]);
    expect(partition.Member).toEqual([]);
    expect(partition.Undetermined).toEqual(repeated);
  }).pipe(Effect.provide(layer));
});
