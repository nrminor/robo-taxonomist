import { expect, it } from "@effect/vitest";
import {
  Array,
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Iterable,
  Layer,
  Option,
  Predicate,
  Record,
  Schema,
} from "effect";
import { AiError, Decision, DecisionModel } from "effect/ai";
import {
  CollectionExecution,
  AcceptancePolicy,
  RecordLabel,
  TaxonomicRecord,
  TaxonName,
  Taxonomy,
  TaxonSet,
  type CollectionMembershipJudgment,
} from "../src/index.ts";

const namedTargetState = Schema.Struct({
  nodes: Schema.Tuple([
    Schema.Struct({
      _tag: Schema.Literal("Taxon"),
      record: Schema.Struct({ scientificName: Schema.String }),
    }),
  ]),
  target: Schema.Literal(0),
});

const firstClassificationQuestion = (decisions: Readonly<Record<string, Decision.Any>>) => {
  const question = Record.get(decisions, "record0").pipe(Option.getOrThrow);
  if (!Predicate.isTagged(question, "Classify")) throw new Error("Expected classification");
  return question;
};

// Supplied answers exercise collection behavior, not biological accuracy.
it.effect(
  "partitions original occurrences into five ordered buckets and retains caller fields",
  () => {
    const member = { scientificName: TaxonName.make("A"), sampleId: "member" };
    const laterMember = { scientificName: TaxonName.make("D"), sampleId: "later member" };
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
          expect(state).toEqual({
            nodes: [{ _tag: "Taxon", record: { scientificName: target } }],
            target: 0,
          });
          expect(Record.keys(decisions)).toEqual([
            "record0",
            "record1",
            "record2",
            "record3",
            "record4",
            "record5",
            "record6",
          ]);
          return Effect.succeed({
            answers: {
              record0: membershipAnswer("member"),
              record1: membershipAnswer("notMember"),
              record2: membershipAnswer("mixed"),
              record3: membershipAnswer("undetermined"),
              record4: membershipAnswer("multipleTarget0"),
              record5: membershipAnswer("notMember"),
              record6: membershipAnswer("member"),
            },
            usage: { inputTokens: undefined, outputTokens: undefined },
          });
        },
      }),
    );
    return Effect.gen(function* () {
      const partition = yield* Taxonomy.partitionRecordsByMembership(
        [member, outside, mixed, unresolved, diagnosed, member, laterMember],
        target,
      );
      expect(partition.Member).toEqual([member, laterMember]);
      expect(partition.Member[0]).toBe(member);
      expect(partition.Member[1]).toBe(laterMember);
      expect(partition.NotMember).toEqual([outside, member]);
      expect(partition.NotMember[0]).toBe(outside);
      expect(partition.NotMember[1]).toBe(member);
      expect(partition.MixedMembership).toEqual([mixed]);
      expect(partition.MixedMembership[0]).toBe(mixed);
      expect(partition.Undetermined).toEqual([unresolved]);
      expect(partition.Undetermined[0]).toBe(unresolved);
      expect(partition.MultipleTaxaInTarget).toEqual([
        { record: diagnosed, target: TaxonSet.of(target) },
      ]);
      expect(partition.MultipleTaxaInTarget[0]?.record).toBe(diagnosed);
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
        const {
          nodes: [node],
        } = Schema.decodeUnknownSync(namedTargetState)(state);
        seen.push(node.record.scientificName);
        return Effect.succeed(response(["member"]));
      },
    }),
  );
  return Effect.gen(function* () {
    const grouped = yield* Taxonomy.groupRecordsByTaxa([record], [genus, family, genus]);
    expect(Array.map(grouped.groups, (group) => group.target)).toEqual([genus, family, genus]);
    expect(seen).toEqual([genus, family, genus]);
    expect(
      grouped.pipe((value) =>
        Array.map(value.groups, (group) =>
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
    Iterable.map(labels, (label, index) => [`record${index}`, membershipAnswer(label)] as const),
  ),
  usage: { inputTokens: undefined, outputTokens: undefined },
});

it.effect.each([
  ["all", Taxonomy.allRecordsBelongTo, "No"],
  ["any", Taxonomy.anyRecordBelongsTo, "No"],
  ["none", Taxonomy.noRecordBelongsTo, "Yes"],
] as const)(
  "groups outside and mixed support before answering %s",
  ([quantifier, operation, tag]) => {
    const layer = Layer.effect(
      DecisionModel.DecisionModel,
      DecisionModel.make({
        decide: () =>
          Effect.succeed({
            answers: {
              record0: {
                _tag: "Classify",
                label: "member",
                probabilities: {
                  member: 0.35,
                  notMember: 0.3,
                  mixed: 0.3,
                  undetermined: 0.05,
                  multipleTarget0: 0,
                },
              },
            },
            usage: { inputTokens: undefined, outputTokens: undefined },
          }),
      }),
    );
    return Effect.gen(function* () {
      expect(
        yield* operation([RecordLabel.make("Pooled subjects")], TaxonName.make("Quercus")),
      ).toEqual({ _tag: tag, quantifier });
    }).pipe(Effect.provide(layer));
  },
);

it.effect("snapshots original record occurrences before consuming later quantifier batches", () => {
  const input = [RecordLabel.make("first"), RecordLabel.make("original second")];
  const facts: string[] = [];
  const layer = Layer.effect(
    DecisionModel.DecisionModel,
    DecisionModel.make({
      decide: ({ decisions }) => {
        const question = firstClassificationQuestion(decisions);
        expect(Record.keys(decisions)).toEqual(["record0"]);
        facts.push(question.instructions);
        // Caller-owned mutation verifies that later batches use the original snapshot.
        if (facts.length === 1) input[1] = RecordLabel.make("replacement second");
        return Effect.succeed(response(["member"]));
      },
    }),
  );
  return Effect.gen(function* () {
    expect(
      yield* Taxonomy.allRecordsBelongTo(input, TaxonName.make("target"), {
        execution: CollectionExecution.make({ batchSize: 1, concurrency: 1 }),
      }),
    ).toEqual({ _tag: "Yes", quantifier: "all" });
    expect(facts).toEqual([
      expect.stringContaining('Record label: "first"'),
      expect.stringContaining('Record label: "original second"'),
    ]);
    expect(input[1]).toBe("replacement second");
  }).pipe(Effect.provide(layer));
});

it.effect("keeps fine membership unresolved when only grouped non-membership is supported", () => {
  const layer = Layer.effect(
    DecisionModel.DecisionModel,
    DecisionModel.make({
      decide: () =>
        Effect.succeed({
          answers: {
            record0: {
              _tag: "Classify",
              label: "member",
              probabilities: {
                member: 0.35,
                notMember: 0.3,
                mixed: 0.3,
                undetermined: 0.05,
                multipleTarget0: 0,
              },
            },
          },
          usage: { inputTokens: undefined, outputTokens: undefined },
        }),
    }),
  );
  return Effect.gen(function* () {
    const record = RecordLabel.make("Pooled subjects");
    const target = TaxonName.make("Quercus");
    expect(yield* Taxonomy.recordBelongsTo(record, target)).toEqual({ _tag: "Undetermined" });
    const partition = yield* Taxonomy.partitionRecordsByMembership([record], target);
    expect(partition.Undetermined).toEqual([record]);
  }).pipe(Effect.provide(layer));
});

it.effect("snapshots one prepared target across batches but prepares it afresh on rerun", () => {
  const targetRecord = { scientificName: TaxonName.make("A") };
  const expression = TaxonSet.of(targetRecord);
  const seen: unknown[] = [];
  const layer = Layer.effect(
    DecisionModel.DecisionModel,
    DecisionModel.make({
      decide: ({ state, decisions }) => {
        seen.push(state);
        const question = firstClassificationQuestion(decisions);
        expect(question.criteria.multipleTarget0).toContain("Target taxon node 0 ");
        expect(
          Schema.decodeUnknownSync(namedTargetState)(state).nodes[0].record.scientificName,
        ).toBe(seen.length <= 2 ? "A" : "B");
        // Caller-owned mutation must not change the prepared request between batches.
        if (seen.length === 1) targetRecord.scientificName = TaxonName.make("B");
        return Effect.succeed(response(["multipleTarget0"]));
      },
    }),
  );
  const operation = Taxonomy.partitionRecordsByMembership(
    [RecordLabel.make("first"), RecordLabel.make("second")],
    expression,
    { execution: CollectionExecution.make({ batchSize: 1, concurrency: 1 }) },
  );
  return Effect.gen(function* () {
    const first = yield* operation;
    const second = yield* operation;
    for (const partition of [first, second]) {
      expect(partition.MultipleTaxaInTarget).toHaveLength(2);
      for (const entry of partition.MultipleTaxaInTarget) expect(entry.target).toBe(expression);
    }
    expect(seen).toEqual([
      { nodes: [{ _tag: "Taxon", record: { scientificName: "A" } }], target: 0 },
      { nodes: [{ _tag: "Taxon", record: { scientificName: "A" } }], target: 0 },
      { nodes: [{ _tag: "Taxon", record: { scientificName: "B" } }], target: 0 },
      { nodes: [{ _tag: "Taxon", record: { scientificName: "B" } }], target: 0 },
    ]);
  }).pipe(Effect.provide(layer));
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

it.effect(
  "does not validate records in an unattempted later window after a decisive answer",
  () => {
    let calls = 0;
    const layer = Layer.effect(
      DecisionModel.DecisionModel,
      DecisionModel.make({
        decide: ({ decisions }) => {
          calls++;
          expect(Record.keys(decisions)).toEqual(["record0"]);
          expect(decisions.record0).toMatchObject({
            instructions: expect.stringContaining('Record label: "decisive"'),
          });
          return Effect.succeed(response(["member"]));
        },
      }),
    );
    return Effect.gen(function* () {
      expect(
        yield* Taxonomy.anyRecordBelongsTo(
          // @ts-expect-error Untyped input in a later, unattempted window has no record facts.
          [RecordLabel.make("decisive"), {}],
          target,
          { execution: CollectionExecution.make({ batchSize: 1, concurrency: 1 }) },
        ),
      ).toEqual({ _tag: "Yes", quantifier: "any" });
      expect(calls).toBe(1);
    }).pipe(Effect.provide(layer));
  },
);

for (const [quantifier, operation] of quantifiers) {
  it.effect.each(["missing", "invalid"] as const)(
    `validates all of one ${quantifier} response before a decisive record: %s`,
    (mode) => {
      let calls = 0;
      const layer = Layer.effect(
        DecisionModel.DecisionModel,
        DecisionModel.make({
          decide: ({ decisions }) => {
            calls++;
            expect(Record.keys(decisions)).toEqual(["record0", "record1"]);
            return Effect.succeed({
              answers: {
                record0: membershipAnswer(quantifier === "all" ? "notMember" : "member"),
                ...(mode === "missing"
                  ? {}
                  : {
                      record1: {
                        _tag: "Classify" as const,
                        label: "invented",
                        probabilities: { invented: 1 },
                      },
                    }),
              },
              usage: { inputTokens: undefined, outputTokens: undefined },
            });
          },
        }),
      );
      return Effect.gen(function* () {
        const error = yield* Effect.flip(
          operation(records, target, {
            execution: CollectionExecution.make({ batchSize: 2, concurrency: 1 }),
          }),
        );
        expect(error.reason._tag).toBe("InvalidOutputError");
        expect(calls).toBe(1);
      }).pipe(Effect.provide(layer));
    },
  );
}

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
        MultipleTaxaInTarget: [],
      });
      expect(first).not.toBe(second);
      expect(first.Member).not.toBe(second.Member);
      expect(first.NotMember).not.toBe(second.NotMember);
      expect(first.MixedMembership).not.toBe(second.MixedMembership);
      expect(first.Undetermined).not.toBe(second.Undetermined);
      expect(first.MultipleTaxaInTarget).not.toBe(second.MultipleTaxaInTarget);
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
        decide: Effect.fnUntraced(function* ({ decisions }) {
          calls++;
          const question = firstClassificationQuestion(decisions);
          const index = question.instructions.endsWith('Scientific name: "F"')
            ? 2
            : question.instructions.endsWith('Scientific name: "C"')
              ? 1
              : 0;
          const names = Array.get([["A", "B", "A"], ["C", "D", "E"], ["F"]], index).pipe(
            Option.getOrThrow,
          );
          expect(Record.keys(decisions)).toEqual(
            Array.map(names, (_name, local) => `record${local}`),
          );
          for (const [local, name] of names.entries()) {
            expect(decisions[`record${local}`]).toMatchObject({
              instructions: expect.stringContaining(`Scientific name: "${name}"`),
            });
          }
          active++;
          maximum = Math.max(maximum, active);
          const slot = Array.get(
            [
              {
                started: firstStarted,
                release: firstRelease,
                labels: ["member", "notMember", "member"],
              },
              {
                started: secondStarted,
                release: secondRelease,
                labels: ["multipleTarget0", "mixed", "member"],
              },
              { started: thirdStarted, release: thirdRelease, labels: ["undetermined"] },
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
    const tail = { scientificName: TaxonName.make("F"), sampleId: "tail" };
    const fiber = yield* Taxonomy.partitionRecordsByMembership(
      [repeated, outside, repeated, diagnosed, mixed, last, tail],
      target,
      {
        execution: CollectionExecution.make({ batchSize: 3, concurrency: 2 }),
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
    expect(Array.map(partition.Member, (record) => record.sampleId)).toEqual([
      "repeat",
      "repeat",
      "last",
    ]);
    expect(partition.Member[0]).toBe(repeated);
    expect(partition.Member[1]).toBe(repeated);
    expect(partition.Member[2]).toBe(last);
    expect(partition.NotMember[0]).toBe(outside);
    expect(partition.MixedMembership[0]).toBe(mixed);
    expect(partition.Undetermined[0]).toBe(tail);
    expect(partition.MultipleTaxaInTarget[0]?.record).toBe(diagnosed);
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
          decide: Effect.fnUntraced(function* ({ decisions }) {
            calls++;
            const question = firstClassificationQuestion(decisions);
            const index = question.instructions.endsWith('Record label: "first"') ? 0 : 1;
            expect(Record.keys(decisions)).toEqual(["record0", "record1"]);
            for (const [local, name] of (index === 0
              ? ["first", "second"]
              : ["third", "fourth"]
            ).entries()) {
              expect(decisions[`record${local}`]).toMatchObject({
                instructions: expect.stringContaining(`Record label: "${name}"`),
              });
            }
            if (calls === 2) yield* Deferred.succeed(bothStarted, undefined);
            yield* Deferred.await(bothStarted);
            if (index === 0) {
              yield* Deferred.await(releaseFirst);
              return response([quantifier === "all" ? "notMember" : "member", "undetermined"]);
            }
            yield* Deferred.succeed(secondCompleted, undefined);
            return response(["multipleTarget0", "undetermined"]);
          }),
        }),
      );
      const fiber = yield* operation([...records, RecordLabel.make("unrequested")], target, {
        execution: CollectionExecution.make({ batchSize: 2, concurrency: 2 }),
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
      const result: CollectionMembershipJudgment = yield* Fiber.join(fiber);
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
        decide: Effect.fnUntraced(function* ({ state, decisions }) {
          const {
            nodes: [node],
          } = yield* Schema.decodeUnknownEffect(namedTargetState)(state).pipe(Effect.orDie);
          calls++;
          active++;
          maximum = Math.max(maximum, active);
          seen.push(node.record.scientificName);
          expect(Record.keys(decisions)).toEqual(["record0"]);
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
        decide: Effect.fnUntraced(function* () {
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
      Taxonomy.partitionRecordsByMembership(records, target, { execution }).pipe(Effect.asVoid),
  ],
  [
    "group",
    (execution: CollectionExecution) =>
      Taxonomy.groupRecordsByTaxa(records, [target, TaxonName.make("unrequested target")], {
        execution,
      }).pipe(Effect.asVoid),
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

for (const [kind, operation] of operations) {
  it.effect.each(["missing", "invalid", "failure"] as const)(
    `fails ${kind} current batch beside a decisive answer: %s`,
    (mode) =>
      Effect.gen(function* () {
        const failure = AiError.make({
          module: "TestProvider",
          method: "decide",
          reason: new AiError.UnknownError({ description: "unavailable" }),
        });
        const firstAnswered = yield* Deferred.make<void>();
        let calls = 0;
        let succeeded = false;
        const layer = Layer.effect(
          DecisionModel.DecisionModel,
          DecisionModel.make({
            decide: Effect.fnUntraced(function* () {
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
      }),
  );
}

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
            return (calls === 2 ? Deferred.succeed(started, undefined) : Effect.void).pipe(
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
        CollectionExecution.make({ batchSize: 1, concurrency: 2 }),
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
      expect(Cause.hasInterruptsOnly(Exit.getCause(exit).pipe(Option.getOrThrow))).toBe(true);
      expect(succeeded).toBe(false);
      expect(calls).toBe(2);
      expect(interrupted).toBe(2);
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
      const cause = Exit.getCause(exit).pipe(Option.getOrThrow);
      expect(
        Array.map(Array.filter(cause.reasons, Cause.isDieReason), (reason) => reason.defect),
      ).toEqual([defect]);
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
            nodes: [
              { _tag: "Union", operands: [1, 2] },
              { _tag: "Taxon", record: { scientificName: "A" } },
              { _tag: "Taxon", record: { scientificName: 'B and "C"' } },
            ],
            target: 0,
          });
          expect(Record.keys(decisions)).toEqual(["record0", "record1"]);
          expect(decisions.record0).toMatchObject({
            instructions: expect.stringContaining('Record label: "voucher \\"one\\"\\nline"'),
          });
          expect(decisions.record1).toMatchObject({
            instructions: expect.stringContaining('Scientific name: "second name"'),
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
        policy: AcceptancePolicy.make({ minimumSupport: 0.8, minimumMargin: 0 }),
      });
      expect(partition.MultipleTaxaInTarget).toEqual([
        { record: first, target: TaxonSet.of(problemName) },
      ]);
      expect(partition.MultipleTaxaInTarget[0]?.record).toBe(first);
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
      const result = yield* operation(records, target, {
        execution: CollectionExecution.make({ batchSize: 1, concurrency: 1 }),
      });
      expect(result).toEqual({
        _tag: "MultipleTaxaInTarget",
        quantifier,
        target: TaxonSet.of(target),
      });
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
          policy: AcceptancePolicy.make({ minimumSupport: 0.8, minimumMargin: 0 }),
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
      expect(grouped.groups[1]?.partition.MultipleTaxaInTarget).toEqual([
        { record: records[2], target: TaxonSet.of(TaxonName.make("other")) },
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
      policy: AcceptancePolicy.make({ minimumSupport: 0.8, minimumMargin: 0 }),
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
        decide: Effect.fnUntraced(function* () {
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
          decide: Effect.fnUntraced(function* ({ decisions }) {
            active++;
            maximum = Math.max(maximum, active);
            sizes.push(Record.size(decisions));
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(release);
            active--;
            return response(
              Array.replicate(
                kind === "any" || kind === "none" ? "notMember" : "member",
                Record.size(decisions),
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
          nodes: [{ _tag: "Difference", left: 1, right: 2 }, { _tag: "Empty" }, { _tag: "Empty" }],
          target: 0,
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
    const malformedTarget = { _tag: "Difference", left: TaxonSet.empty() };
    const invalidRecords = [
      // @ts-expect-error Untyped caller supplies a record without facts.
      Taxonomy.partitionRecordsByMembership([{}], target).pipe(Effect.asVoid),
      // @ts-expect-error Untyped caller supplies a blank target name.
      Taxonomy.groupRecordsByTaxa(records, [" "]).pipe(Effect.asVoid),
      // @ts-expect-error Untyped caller supplies a malformed recursive target.
      Taxonomy.allRecordsBelongTo(records, malformedTarget).pipe(Effect.asVoid),
      // @ts-expect-error Untyped caller supplies an invalid record.
      Taxonomy.anyRecordBelongsTo([42], target).pipe(Effect.asVoid),
      // @ts-expect-error Untyped caller supplies a blank record label.
      Taxonomy.noRecordBelongsTo([" "], target).pipe(Effect.asVoid),
    ];
    for (const operation of invalidRecords) {
      const error = yield* Effect.flip(operation);
      expect(error.reason._tag).toBe("InvalidUserInputError");
    }
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
  const [, operation] = Array.findFirst(quantifiers, ([kind]) => kind === quantifier).pipe(
    Option.getOrThrow,
  );
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

for (const [quantifier, operation] of quantifiers) {
  const decisive = quantifier === "all" ? "mixed" : "member";
  it.effect.each([
    [
      "decisive before diagnosis",
      ["undetermined", decisive, "multipleTarget0"],
      { _tag: quantifier === "any" ? "Yes" : "No", quantifier },
    ],
    [
      "diagnosis before decisive",
      ["undetermined", "multipleTarget0", decisive],
      { _tag: "MultipleTaxaInTarget", quantifier, target: TaxonSet.of(target) },
    ],
  ] as const)(`scans ${quantifier} in record order: %s`, ([_case, labels, expected]) =>
    Effect.gen(function* () {
      const layer = Layer.effect(
        DecisionModel.DecisionModel,
        DecisionModel.make({ decide: () => Effect.succeed(response(labels)) }),
      );
      expect(yield* operation(records.slice(0, 3), target).pipe(Effect.provide(layer))).toEqual(
        expected,
      );
    }),
  );
}

it.effect("uses default batches of 16 and independently applies policy to each answer", () => {
  const sizes: number[] = [];
  const layer = Layer.effect(
    DecisionModel.DecisionModel,
    DecisionModel.make({
      decide: ({ decisions }) => {
        sizes.push(Record.size(decisions));
        return Effect.succeed({
          answers: Record.map(decisions, (): DecisionModel.ProviderClassifyAnswer => ({
            _tag: "Classify",
            label: "member",
            probabilities: {
              member: 0.75,
              notMember: 0.25,
              mixed: 0,
              undetermined: 0,
              multipleTarget0: 0,
            },
          })),
          usage: { inputTokens: undefined, outputTokens: undefined },
        });
      },
    }),
  );
  return Effect.gen(function* () {
    const repeated = Array.replicate(RecordLabel.make("same occurrence text"), 35);
    const partition = yield* Taxonomy.partitionRecordsByMembership(repeated, target, {
      policy: AcceptancePolicy.make({ minimumSupport: 0.8, minimumMargin: 0 }),
    });
    expect(sizes).toEqual([16, 16, 3]);
    expect(partition.Member).toEqual([]);
    expect(partition.Undetermined).toEqual(repeated);
  }).pipe(Effect.provide(layer));
});

it.effect(
  "associates cross-batch repeated references with their own answers after full reversal",
  () =>
    Effect.gen(function* () {
      const firstStarted = yield* Deferred.make<void>();
      const secondStarted = yield* Deferred.make<void>();
      const thirdStarted = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      const releaseSecond = yield* Deferred.make<void>();
      const releaseThird = yield* Deferred.make<void>();
      const secondFinished = yield* Deferred.make<void>();
      const thirdFinished = yield* Deferred.make<void>();
      const first = TaxonomicRecord.make({ scientificName: TaxonName.make("first sentinel") });
      const second = TaxonomicRecord.make({ scientificName: TaxonName.make("second sentinel") });
      const third = TaxonomicRecord.make({ scientificName: TaxonName.make("third sentinel") });
      const shared = { scientificName: TaxonName.make("shared"), sampleId: "same object" };
      const outside = TaxonomicRecord.make({ scientificName: TaxonName.make("outside") });
      const uncertain = TaxonomicRecord.make({ scientificName: TaxonName.make("uncertain") });
      const completed: string[] = [];
      const layer = Layer.effect(
        DecisionModel.DecisionModel,
        DecisionModel.make({
          decide: Effect.fnUntraced(function* ({ decisions }) {
            const question = firstClassificationQuestion(decisions);
            if (question.instructions.endsWith('Scientific name: "first sentinel"')) {
              expect(Record.keys(decisions)).toEqual(["record0", "record1", "record2"]);
              expect(decisions.record1).toMatchObject({
                instructions: expect.stringContaining('Scientific name: "shared"'),
              });
              expect(decisions.record2).toMatchObject({
                instructions: expect.stringContaining('Scientific name: "outside"'),
              });
              yield* Deferred.succeed(firstStarted, undefined);
              yield* Deferred.await(releaseFirst);
              completed.push("first");
              return response(["member", "member", "notMember"]);
            }
            if (question.instructions.endsWith('Scientific name: "second sentinel"')) {
              expect(Record.keys(decisions)).toEqual(["record0", "record1", "record2"]);
              expect(decisions.record1).toMatchObject({
                instructions: expect.stringContaining('Scientific name: "shared"'),
              });
              expect(decisions.record2).toMatchObject({
                instructions: expect.stringContaining('Scientific name: "uncertain"'),
              });
              yield* Deferred.succeed(secondStarted, undefined);
              yield* Deferred.await(releaseSecond);
              completed.push("second");
              yield* Deferred.succeed(secondFinished, undefined);
              return response(["mixed", "multipleTarget0", "undetermined"]);
            }
            expect(question.instructions).toContain('Scientific name: "third sentinel"');
            expect(Record.keys(decisions)).toEqual(["record0", "record1"]);
            expect(decisions.record1).toMatchObject({
              instructions: expect.stringContaining('Scientific name: "shared"'),
            });
            yield* Deferred.succeed(thirdStarted, undefined);
            yield* Deferred.await(releaseThird);
            completed.push("third");
            yield* Deferred.succeed(thirdFinished, undefined);
            return response(["member", "notMember"]);
          }),
        }),
      );
      const fiber = yield* Taxonomy.partitionRecordsByMembership(
        [first, shared, outside, second, shared, uncertain, third, shared],
        target,
        { execution: CollectionExecution.make({ batchSize: 3, concurrency: 3 }) },
      ).pipe(Effect.provide(layer), Effect.forkChild);
      yield* Deferred.await(firstStarted);
      yield* Deferred.await(secondStarted);
      yield* Deferred.await(thirdStarted);
      yield* Deferred.succeed(releaseThird, undefined);
      yield* Deferred.await(thirdFinished);
      yield* Deferred.succeed(releaseSecond, undefined);
      yield* Deferred.await(secondFinished);
      yield* Deferred.succeed(releaseFirst, undefined);
      const partition = yield* Fiber.join(fiber);
      expect(completed).toEqual(["third", "second", "first"]);
      expect(partition).toEqual({
        Member: [first, shared, third],
        NotMember: [outside, shared],
        MixedMembership: [second],
        Undetermined: [uncertain],
        MultipleTaxaInTarget: [{ record: shared, target: TaxonSet.of(target) }],
      });
      expect(partition.Member[0]).toBe(first);
      expect(partition.Member[1]).toBe(shared);
      expect(partition.Member[2]).toBe(third);
      expect(partition.NotMember[0]).toBe(outside);
      expect(partition.NotMember[1]).toBe(shared);
      expect(partition.MixedMembership[0]).toBe(second);
      expect(partition.Undetermined[0]).toBe(uncertain);
      expect(partition.MultipleTaxaInTarget[0]?.record).toBe(shared);
    }),
);

it.effect.each(["failure", "interrupt"] as const)(
  "isolates independent operations after A %s and reruns the identical A Effect freshly",
  (mode) =>
    Effect.gen(function* () {
      const bStarted = yield* Deferred.make<void>();
      const releaseB = yield* Deferred.make<void>();
      const aReachedFault = yield* Deferred.make<void>();
      const releaseFault = yield* Deferred.make<void>();
      const aFirst = TaxonomicRecord.make({ scientificName: TaxonName.make("A first") });
      const aSecond = TaxonomicRecord.make({ scientificName: TaxonName.make("A second") });
      const bRecord = TaxonomicRecord.make({ scientificName: TaxonName.make("B only") });
      const failure = AiError.make({
        module: "TestProvider",
        method: "decide",
        reason: new AiError.UnknownError({ description: "A failed after progress" }),
      });
      let aFinalized = 0;
      let bFinalized = 0;
      let bSucceeded = false;
      const aLayer = Layer.effect(
        DecisionModel.DecisionModel,
        DecisionModel.make({
          decide: Effect.fnUntraced(
            function* ({ decisions }) {
              const question = firstClassificationQuestion(decisions);
              if (question.instructions.endsWith('Scientific name: "A first"')) {
                // B must already be pending when A makes successful progress.
                yield* Deferred.await(bStarted);
                return response(["member"]);
              }
              expect(question.instructions).toContain('Scientific name: "A second"');
              yield* Deferred.succeed(aReachedFault, undefined);
              yield* Deferred.await(releaseFault);
              if (mode === "failure") return yield* failure;
              return yield* Effect.never;
            },
            Effect.ensuring(
              Effect.sync(() => {
                aFinalized++;
              }),
            ),
          ),
        }),
      );
      const bLayer = Layer.effect(
        DecisionModel.DecisionModel,
        DecisionModel.make({
          decide: Effect.fnUntraced(
            function* () {
              yield* Deferred.succeed(bStarted, undefined);
              yield* Deferred.await(releaseB);
              return response(["mixed"]);
            },
            Effect.ensuring(
              Effect.sync(() => {
                bFinalized++;
              }),
            ),
          ),
        }),
      );
      const operationA = Taxonomy.partitionRecordsByMembership([aFirst, aSecond], target, {
        execution: CollectionExecution.make({ batchSize: 1, concurrency: 1 }),
      });
      const fiberB = yield* Taxonomy.partitionRecordsByMembership([bRecord], target).pipe(
        Effect.provide(bLayer),
        Effect.tap(() =>
          Effect.sync(() => {
            bSucceeded = true;
          }),
        ),
        Effect.forkChild,
      );
      const fiberA = yield* operationA.pipe(Effect.provide(aLayer), Effect.forkChild);
      yield* Deferred.await(aReachedFault);
      expect(aFinalized).toBe(1);
      if (mode === "failure") yield* Deferred.succeed(releaseFault, undefined);
      else yield* Fiber.interrupt(fiberA);
      const exitA = yield* Fiber.await(fiberA);
      const causeA = Exit.getCause(exitA).pipe(Option.getOrThrow);
      if (mode === "failure") {
        expect(causeA.reasons).toHaveLength(1);
        expect(causeA.reasons[0]?._tag).toBe("Fail");
        expect(Cause.findErrorOption(causeA).pipe(Option.getOrThrow)).toBe(failure);
      } else expect(Cause.hasInterruptsOnly(causeA)).toBe(true);
      expect(aFinalized).toBe(2);
      expect(bFinalized).toBe(0);
      expect(bSucceeded).toBe(false);
      yield* Deferred.succeed(releaseB, undefined);
      const partitionB = yield* Fiber.join(fiberB);
      expect(partitionB).toEqual({
        Member: [],
        NotMember: [],
        MixedMembership: [bRecord],
        Undetermined: [],
        MultipleTaxaInTarget: [],
      });
      expect(partitionB.MixedMembership[0]).toBe(bRecord);
      expect(bFinalized).toBe(1);
      const freshLayer = Layer.effect(
        DecisionModel.DecisionModel,
        DecisionModel.make({
          decide: () => Effect.succeed(response(["multipleTarget0"])),
        }),
      );
      const fresh = yield* operationA.pipe(Effect.provide(freshLayer));
      expect(fresh).toEqual({
        Member: [],
        NotMember: [],
        MixedMembership: [],
        Undetermined: [],
        MultipleTaxaInTarget: [
          { record: aFirst, target: TaxonSet.of(target) },
          { record: aSecond, target: TaxonSet.of(target) },
        ],
      });
      expect(fresh.MultipleTaxaInTarget[0]?.record).toBe(aFirst);
      expect(fresh.MultipleTaxaInTarget[1]?.record).toBe(aSecond);
      expect(aFinalized).toBe(2);
    }),
);

it.effect.each(["failure", "interrupt"] as const)(
  "discards completed groups after middle-target %s and rereads repeated expressions on rerun",
  (mode) =>
    Effect.gen(function* () {
      const middleBlocked = yield* Deferred.make<void>();
      const targetRecord = { scientificName: TaxonName.make("before") };
      const expression = TaxonSet.of(targetRecord);
      const middle = TaxonSet.of(TaxonName.make("middle"));
      const first = TaxonomicRecord.make({ scientificName: TaxonName.make("first record") });
      const second = TaxonomicRecord.make({ scientificName: TaxonName.make("second record") });
      const failure = AiError.make({
        module: "TestProvider",
        method: "decide",
        reason: new AiError.UnknownError({ description: "middle failed" }),
      });
      const seen: string[] = [];
      let attempts = 0;
      let finalized = 0;
      let succeeded = false;
      const layer = Layer.effect(
        DecisionModel.DecisionModel,
        DecisionModel.make({
          decide: Effect.fnUntraced(
            function* ({ state, decisions }) {
              attempts++;
              const {
                nodes: [node],
              } = yield* Schema.decodeUnknownEffect(namedTargetState)(state).pipe(Effect.orDie);
              seen.push(node.record.scientificName);
              if (node.record.scientificName === "before") return response(["member"]);
              expect(node.record.scientificName).toBe("middle");
              const question = firstClassificationQuestion(decisions);
              if (question.instructions.endsWith('Scientific name: "first record"')) {
                yield* Deferred.await(middleBlocked);
                if (mode === "failure") return yield* failure;
                return yield* Effect.never;
              }
              expect(question.instructions).toContain('Scientific name: "second record"');
              yield* Deferred.succeed(middleBlocked, undefined);
              return yield* Effect.never;
            },
            Effect.ensuring(
              Effect.sync(() => {
                finalized++;
              }),
            ),
          ),
        }),
      );
      const operation = Taxonomy.groupRecordsByTaxa(
        [first, second],
        [expression, middle, expression],
        {
          execution: CollectionExecution.make({ batchSize: 1, concurrency: 2 }),
        },
      );
      const fiber = yield* operation.pipe(
        Effect.provide(layer),
        Effect.tap(() =>
          Effect.sync(() => {
            succeeded = true;
          }),
        ),
        Effect.forkChild,
      );
      yield* Deferred.await(middleBlocked);
      if (mode === "interrupt") yield* Fiber.interrupt(fiber);
      const exit = yield* Fiber.await(fiber);
      const cause = Exit.getCause(exit).pipe(Option.getOrThrow);
      if (mode === "failure") {
        expect(cause.reasons).toHaveLength(1);
        expect(cause.reasons[0]?._tag).toBe("Fail");
        expect(Cause.findErrorOption(cause).pipe(Option.getOrThrow)).toBe(failure);
      } else expect(Cause.hasInterruptsOnly(cause)).toBe(true);
      expect(succeeded).toBe(false);
      expect(seen).toEqual(["before", "before", "middle", "middle"]);
      expect(attempts).toBe(4);
      expect(finalized).toBe(4);
      const freshName = TaxonName.make('after "fresh"');
      // Caller-owned mutation must be observed by fresh preparation on rerun.
      targetRecord.scientificName = freshName;
      const freshSeen: string[] = [];
      const freshLayer = Layer.effect(
        DecisionModel.DecisionModel,
        DecisionModel.make({
          decide: Effect.fnUntraced(function* ({ state, decisions }) {
            const {
              nodes: [node],
            } = yield* Schema.decodeUnknownEffect(namedTargetState)(state).pipe(Effect.orDie);
            freshSeen.push(node.record.scientificName);
            expect(decisions.record0).toMatchObject({
              criteria: {
                multipleTarget0: expect.stringContaining("Target taxon node 0 "),
              },
            });
            return response(["multipleTarget0"]);
          }),
        }),
      );
      const fresh = yield* operation.pipe(Effect.provide(freshLayer));
      expect(freshSeen).toEqual([freshName, freshName, "middle", "middle", freshName, freshName]);
      expect(Array.map(fresh.groups, (group) => group.target)).toEqual([
        expression,
        middle,
        expression,
      ]);
      expect(fresh.groups[0]?.target).toBe(expression);
      expect(fresh.groups[1]?.target).toBe(middle);
      expect(fresh.groups[2]?.target).toBe(expression);
      expect(Array.map(fresh.groups, (group) => group.partition)).toEqual([
        {
          Member: [],
          NotMember: [],
          MixedMembership: [],
          Undetermined: [],
          MultipleTaxaInTarget: [
            { record: first, target: expression },
            { record: second, target: expression },
          ],
        },
        {
          Member: [],
          NotMember: [],
          MixedMembership: [],
          Undetermined: [],
          MultipleTaxaInTarget: [
            { record: first, target: TaxonSet.of(TaxonName.make("middle")) },
            { record: second, target: TaxonSet.of(TaxonName.make("middle")) },
          ],
        },
        {
          Member: [],
          NotMember: [],
          MixedMembership: [],
          Undetermined: [],
          MultipleTaxaInTarget: [
            { record: first, target: expression },
            { record: second, target: expression },
          ],
        },
      ]);
      for (const group of fresh.groups) {
        expect(group.partition.MultipleTaxaInTarget[0]?.record).toBe(first);
        expect(group.partition.MultipleTaxaInTarget[1]?.record).toBe(second);
      }
      expect(fresh.groups[0]?.partition).not.toBe(fresh.groups[2]?.partition);
      expect(seen).toEqual(["before", "before", "middle", "middle"]);
      expect(attempts).toBe(4);
      expect(finalized).toBe(4);
    }),
);
