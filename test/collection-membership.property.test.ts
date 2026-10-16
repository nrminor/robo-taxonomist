import { expect, it } from "@effect/vitest";
import { Arbitrary, Cause, Deferred, Effect, Exit, Fiber, Layer, Schema } from "effect";
import { AiError, DecisionModel } from "effect/ai";
import {
  CollectionExecution,
  TaxonName,
  Taxonomy,
  TaxonSet,
  type RecordMembershipPartition,
} from "../src/index.ts";

// Bounded generated inputs must be initialized before property registration.
// Keep the observable promises next; their private oracles and drivers follow below.
const labels = Schema.Literals(["member", "notMember", "mixed", "undetermined", "multipleTarget0"]);
const membershipInputs = Arbitrary.all({
  count: Arbitrary.schema(Schema.Literals([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])),
  batch: Arbitrary.schema(Schema.Literals([1, 2, 3, 4])),
  concurrency: Arbitrary.schema(Schema.Literals([1, 2, 3])),
  repeated: Arbitrary.schema(Schema.Boolean),
}).pipe(
  Arbitrary.flatMap((shape) =>
    Arbitrary.all({
      ledger: Arbitrary.array(Arbitrary.schema(labels), {
        minLength: shape.count,
        maxLength: shape.count,
      }),
      choices: Arbitrary.array(Arbitrary.schema(Schema.Boolean), { minLength: 1, maxLength: 12 }),
    }).pipe(Arbitrary.map((answers) => ({ ...shape, ...answers }))),
  ),
);
const faultDescription = Arbitrary.all({
  kind: Arbitrary.schema(Schema.Literals(["partition", "group", "all", "any", "none"])),
  fault: Arbitrary.schema(Schema.Literals(["failure", "invalid", "defect", "interrupt"])),
  priorWindow: Arbitrary.schema(Schema.Boolean),
  batch: Arbitrary.schema(Schema.Literals([1, 2])),
  concurrency: Arbitrary.schema(Schema.Literals([1, 2])),
});
const isolationDescription = Arbitrary.all({
  count: Arbitrary.schema(Schema.Literals([2, 3, 4, 5, 6])),
  concurrencyA: Arbitrary.schema(Schema.Literals([1, 2, 3])),
  concurrencyB: Arbitrary.schema(Schema.Literals([1, 2, 3])),
  abort: Arbitrary.schema(Schema.Literals(["failure", "interrupt"])),
}).pipe(
  Arbitrary.flatMap((shape) =>
    Arbitrary.array(Arbitrary.schema(labels), {
      minLength: shape.count,
      maxLength: shape.count,
    }).pipe(Arbitrary.map((ledgerB) => ({ ...shape, ledgerB }))),
  ),
);
const groupDescription = Arbitrary.all({
  count: Arbitrary.schema(Schema.Literals([1, 2, 3, 4])),
  batch: Arbitrary.schema(Schema.Literals([1, 2])),
  concurrency: Arbitrary.schema(Schema.Literals([1, 2, 3])),
  extra: Arbitrary.schema(Schema.Boolean),
  abort: Arbitrary.schema(Schema.Literals(["failure", "interrupt"])),
});

it.effect.prop(
  "batch size and completion order preserve record order, repeats and the first decisive answer",
  [membershipInputs],
  ([description]) =>
    Effect.gen(function* () {
      // Source occurrence order wins over callback completion order, even for identical references.
      const records = specimens(description.count, description.repeated);
      const expectedPartition = partitionFromLedger(records, description.ledger);
      const expectedSchedules = expectedOccurrenceSchedules(description);
      const observed = yield* observeMembershipExecution(description, records);
      observed.forEach(({ partition, transport, quantifiers }, index) => {
        const expected = at(expectedSchedules, index);
        expect(partition).toEqual(expectedPartition);
        expect(preservesOccurrenceIdentity(partition, expectedPartition)).toBe(true);
        expect(sorted(transport.started)).toEqual(expected.started);
        if (expected.reversed !== undefined) expect(transport.finished).toEqual(expected.reversed);
        expectStopped(transport);
        quantifiers.forEach((scan, quantifierIndex) => {
          const expectedScan = at(expected.quantifiers, quantifierIndex);
          expect(scan.actual).toEqual(expectedScan.answer);
          expect(sorted(scan.transport.started)).toEqual(expectedScan.started);
          expectStopped(scan.transport);
        });
      });
    }),
  { timeout: 20_000, arbitrary: { runs: 80, seed: "collection-C1", maxShrinks: 40 } },
);

it.effect.prop(
  "failed or cancelled requests cannot produce a successful partial result",
  [faultDescription],
  ([description]) =>
    Effect.gen(function* () {
      const observed = yield* observeReachedFault(description);
      // A decisive sibling is not permission to swallow a reached request's fault.
      expect(observed.faultWasActive).toBe(true);
      expectFault(observed.exit, description.fault);
      expectStopped(observed.atExit);
      expect(sorted(observed.atExit.finished)).toEqual(sorted(observed.atExit.started));
      // Parent-fiber observation after one turn; not an unbounded future-work guarantee.
      expect(observed.afterTurn.started).toHaveLength(observed.atExit.started.length);
      expectStopped(observed.afterTurn);
    }),
  { timeout: 20_000, arbitrary: { runs: 80, seed: "collection-C2", maxShrinks: 30 } },
);

it.effect.prop(
  "one failed run does not stop another, and rerunning the same Effect uses fresh answers",
  [isolationDescription],
  ([description]) =>
    Effect.gen(function* () {
      const recordsA = specimens(description.count, false, "A");
      const recordsB = specimens(description.count, false, "B");
      const originalLedger: Label[] = recordsA.map(() => "member");
      const freshLedger: Label[] = recordsA.map(() => "multipleTarget0");
      const expectedB = partitionFromLedger(recordsB, description.ledgerB);
      const expectedRerun = partitionFromLedger(recordsA, freshLedger);
      const observed = yield* runIndependentExecutions(description, {
        recordsA,
        recordsB,
        originalLedger,
        freshLedger,
      });
      expect(observed.aHadProgress).toBe(true);
      expect(observed.bWasActive).toBe(true);
      expectFault(observed.exitA, description.abort);
      expectStopped(observed.aAtExit);
      // B is not released until A's failed Exit is observed: fail-fast cancellation would fail here.
      expect(Exit.isSuccess(observed.exitB)).toBe(true);
      if (Exit.isSuccess(observed.exitB)) {
        expect(observed.exitB.value).toEqual(expectedB);
        expect(preservesOccurrenceIdentity(observed.exitB.value, expectedB)).toBe(true);
      }
      expectStopped(observed.bAtExit);
      expect(observed.rerunPartition).toEqual(expectedRerun);
      expect(preservesOccurrenceIdentity(observed.rerunPartition, expectedRerun)).toBe(true);
      expect(observed.rerun.started).toHaveLength(description.count);
      expectStopped(observed.rerun);
      expectStopped(observed.aAfterRerun);
      expectStopped(observed.bAfterRerun);
    }),
  { timeout: 20_000, arbitrary: { runs: 50, seed: "collection-C3", maxShrinks: 30 } },
);

it.effect.prop(
  "failed grouping returns no partial groups and rereads repeated targets on rerun",
  [groupDescription],
  ([description]) =>
    Effect.gen(function* () {
      const records = specimens(description.count, false);
      const expression = TaxonSet.of(TaxonName.make("before"));
      const middle = TaxonSet.of(TaxonName.make("middle"));
      const targets = description.extra
        ? [expression, middle, TaxonSet.of(TaxonName.make("other")), expression]
        : [expression, middle, expression];
      const freshName = TaxonName.make('after "fresh"');
      const expectedNames = description.extra
        ? [freshName, "middle", "other", freshName]
        : [freshName, "middle", freshName];
      const diagnosisLedger: Label[] = records.map(() => "multipleTarget0");
      const expectedPartitions = expectedNames.map((name) =>
        partitionFromLedger(records, diagnosisLedger, TaxonName.make(name)),
      );
      const batches = Math.ceil(description.count / description.batch);
      const expectedBeforeAbort = [
        ...Array.from({ length: batches }, () => "before"),
        ...Array.from({ length: Math.min(description.concurrency, batches) }, () => "middle"),
      ];
      const expectedFreshCalls = expectedNames.flatMap((name) =>
        Array.from({ length: batches }, () => name),
      );
      const observed = yield* observeGroupingRestart(description, {
        records,
        expression,
        targets,
        freshName,
      });
      expect(observed.failed.beforeAbort.seen).toEqual(expectedBeforeAbort);
      expectFault(observed.failed.exit, description.abort);
      expectGroupStopped(observed.failed.atExit);
      expect(observed.failed.afterTurn.seen).toHaveLength(observed.failed.atExit.seen.length);
      expectGroupStopped(observed.failed.afterTurn);
      // The same Effect must reread both occurrences of the mutated target, in entry order.
      expect(observed.grouped.groups).toHaveLength(targets.length);
      observed.grouped.groups.forEach((group, index) => {
        expect(group.target).toBe(at(targets, index));
        const expected = at(expectedPartitions, index);
        expect(group.partition).toEqual(expected);
        expect(preservesOccurrenceIdentity(group.partition, expected)).toBe(true);
      });
      expect(observed.fresh.seen).toEqual(expectedFreshCalls);
      expectGroupStopped(observed.fresh);
      expectGroupStopped(observed.firstAfterRerun);
    }),
  { timeout: 20_000, arbitrary: { runs: 50, seed: "collection-C4", maxShrinks: 30 } },
);

it.effect(
  "out-of-order batches preserve distinct answers for repeated records and a short final batch",
  () =>
    Effect.gen(function* () {
      for (const description of occurrenceWitnesses) {
        const records = specimens(description.count, description.repeated);
        const expectedPartition = partitionFromLedger(records, description.ledger);
        const expectedSchedules = expectedOccurrenceSchedules(description);
        const observed = yield* observeMembershipExecution(description, records);
        observed.forEach(({ partition, transport, quantifiers }, index) => {
          const expected = at(expectedSchedules, index);
          expect(partition).toEqual(expectedPartition);
          expect(preservesOccurrenceIdentity(partition, expectedPartition)).toBe(true);
          expect(sorted(transport.started)).toEqual(expected.started);
          if (expected.reversed !== undefined)
            expect(transport.finished).toEqual(expected.reversed);
          expectStopped(transport);
          quantifiers.forEach((scan, quantifierIndex) => {
            const expectedScan = at(expected.quantifiers, quantifierIndex);
            expect(scan.actual).toEqual(expectedScan.answer);
            expect(sorted(scan.transport.started)).toEqual(expectedScan.started);
            expectStopped(scan.transport);
          });
        });
      }
    }),
);

// Post-exit assertions: adapters enforce request legality, not these lifetime promises.
function sorted(ranks: readonly number[]) {
  return [...ranks].sort((a, b) => a - b);
}
function expectStopped(observed: {
  readonly lateAttempts: number;
  readonly attempts: number;
  readonly active: number;
  readonly started: readonly number[];
}) {
  expect(observed.lateAttempts).toBe(0);
  expect(observed.attempts).toBe(observed.started.length);
  expect(observed.active).toBe(0);
}
function expectGroupStopped(observed: {
  readonly lateAttempts: number;
  readonly attempts: number;
  readonly active: number;
  readonly finalized: number;
  readonly seen: readonly string[];
}) {
  expect(observed.lateAttempts).toBe(0);
  expect(observed.attempts).toBe(observed.seen.length);
  expect(observed.active).toBe(0);
  expect(observed.finalized).toBe(observed.seen.length);
}
function expectFault(exit: Exit.Exit<unknown, AiError.AiError>, fault: Fault) {
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    if (fault === "interrupt") expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    else if (fault === "defect")
      expect(exit.cause.reasons.filter(Cause.isDieReason).map((r) => r.defect)).toContain(
        "reached injected defect",
      );
    else
      expect(
        exit.cause.reasons.filter(Cause.isFailReason).map((r) => r.error.reason._tag),
      ).toContain(fault === "failure" ? "UnknownError" : "InvalidOutputError");
  }
}

// Occurrence fixtures and independent oracles. No provider or fiber state belongs here.
type Label = typeof labels.Type;
type Specimen = { readonly scientificName: TaxonName; readonly voucher: number };
type Quantifier = "all" | "any" | "none";
type Fault = "failure" | "invalid" | "defect" | "interrupt";
type ProviderFault = Exclude<Fault, "interrupt">;
type Descriptor = {
  readonly count: number;
  readonly batch: number;
  readonly concurrency: number;
  readonly repeated: boolean;
  readonly ledger: readonly Label[];
  readonly choices: readonly boolean[];
};
type Generated<A> = A extends Arbitrary.Arbitrary<infer D> ? D : never;
type FaultDescription = Generated<typeof faultDescription>;
type IsolationDescription = Generated<typeof isolationDescription>;
type GroupDescription = Generated<typeof groupDescription>;
const target = TaxonName.make('target "original"');

/** Fail fast if a bounded fixture or schedule asks for a nonexistent occurrence. */
function at<A>(values: readonly A[], index: number): A {
  const value = values[index];
  if (value === undefined) throw new Error(`Missing bounded fixture entry ${index}`);
  return value;
}

/** Every third occurrence is unique: a B=3 request can be identified even with shared records. */
function specimens(count: number, repeated: boolean, prefix = "record"): Specimen[] {
  const shared = { scientificName: TaxonName.make(`${prefix} shared`), voucher: -1 };
  return Array.from({ length: count }, (_, index) =>
    repeated && index % 3 !== 0
      ? shared
      : { scientificName: TaxonName.make(`${prefix} ${index}`), voucher: index },
  );
}

/** Minimum terminal occurrence, independent of batching, completion order and production code. */
function terminalIndex(ledger: readonly Label[], kind: Quantifier) {
  return ledger.findIndex(
    (label) =>
      label === "multipleTarget0" ||
      (kind === "all" ? label === "notMember" || label === "mixed" : label === "member"),
  );
}

/** Quantifier truth table over source occurrences, not provider completion order. */
function quantified(ledger: readonly Label[], quantifier: Quantifier) {
  const index = terminalIndex(ledger, quantifier);
  if (index >= 0)
    return at(ledger, index) === "multipleTarget0"
      ? { _tag: "MultipleTaxaInTargetName", quantifier, targetName: target }
      : { _tag: quantifier === "any" ? "Yes" : "No", quantifier };
  return {
    _tag: ledger.includes("undetermined") ? "Undetermined" : quantifier === "any" ? "No" : "Yes",
    quantifier,
  };
}

/** Select exact expected buckets solely from the supplied occurrence ledger. */
function partitionFromLedger(
  records: readonly Specimen[],
  ledger: readonly Label[],
  name = target,
) {
  const selected = (label: Label) => records.filter((_, index) => at(ledger, index) === label);
  return {
    Member: selected("member"),
    NotMember: selected("notMember"),
    MixedMembership: selected("mixed"),
    Undetermined: selected("undetermined"),
    MultipleTaxaInTargetName: selected("multipleTarget0").map((record) => ({
      record,
      targetName: name,
    })),
  };
}

/** Deep equality misses copied records; compare each expected occurrence by strict identity too. */
function preservesOccurrenceIdentity(
  actual: RecordMembershipPartition<Specimen>,
  expected: ReturnType<typeof partitionFromLedger>,
) {
  const sameRecords = (left: readonly Specimen[], right: readonly Specimen[]) =>
    left.length === right.length && left.every((record, index) => record === at(right, index));
  return (
    sameRecords(actual.Member, expected.Member) &&
    sameRecords(actual.NotMember, expected.NotMember) &&
    sameRecords(actual.MixedMembership, expected.MixedMembership) &&
    sameRecords(actual.Undetermined, expected.Undetermined) &&
    actual.MultipleTaxaInTargetName.length === expected.MultipleTaxaInTargetName.length &&
    actual.MultipleTaxaInTargetName.every(
      (entry, index) =>
        entry.record === at(expected.MultipleTaxaInTargetName, index).record &&
        entry.targetName === at(expected.MultipleTaxaInTargetName, index).targetName,
    )
  );
}

/** Source bounds and terminal-window rules are calculated by the roots before execution. */
function expectedOccurrenceSchedules(description: Descriptor) {
  const batches = description.repeated ? [3] : [...new Set([description.batch, 1])];
  return batches.flatMap((batchSize) =>
    [...new Set([description.concurrency, 1])].map((concurrency) => {
      const batchCount = Math.ceil(description.count / batchSize);
      const started = Array.from({ length: batchCount }, (_, rank) => rank);
      return {
        started,
        reversed:
          batchCount <= concurrency && description.choices.every((choice) => choice)
            ? [...started].reverse()
            : undefined,
        quantifiers: (["all", "any", "none"] satisfies Quantifier[]).map((kind) => {
          const terminal = terminalIndex(description.ledger, kind);
          const reached =
            terminal < 0
              ? batchCount
              : Math.min(
                  batchCount,
                  Math.ceil((terminal + 1) / (batchSize * concurrency)) * concurrency,
                );
          return {
            answer: quantified(description.ledger, kind),
            started: started.slice(0, reached),
          };
        }),
      };
    }),
  );
}

// Fixed witnesses supplement the seeded properties: repeated-reference answers differ,
// sentinels identify reversed B=3 requests, and both examples end in a short batch.
const occurrenceWitnesses: readonly Descriptor[] = [
  {
    count: 8,
    batch: 3,
    concurrency: 3,
    repeated: true,
    choices: [true],
    ledger: [
      "undetermined",
      "member",
      "notMember",
      "multipleTarget0",
      "mixed",
      "member",
      "notMember",
      "multipleTarget0",
    ],
  },
  {
    count: 7,
    batch: 2,
    concurrency: 2,
    repeated: false,
    choices: [true],
    ledger: [
      "undetermined",
      "undetermined",
      "undetermined",
      "undetermined",
      "multipleTarget0",
      "member",
      "mixed",
    ],
  },
];

// Public-operation observers. These return only observations; the properties above
// retain their independent expectations. Each evaluation, shrink and replay gets
// fresh gates. onExit is the authoritative settlement point, not the parent's join.
// A post-exit yield offers one bounded observation turn, not a guarantee about all
// future work. Test timeouts are deadlock watchdogs, not latency requirements.
const quantify = {
  all: Taxonomy.allRecordsBelongTo,
  any: Taxonomy.anyRecordBelongsTo,
  none: Taxonomy.noRecordBelongsTo,
};

/** Partition, then each quantifier, across the original B/C cross-product. */
function observeMembershipExecution(description: Descriptor, records: readonly Specimen[]) {
  return Effect.gen(function* () {
    const batches = description.repeated ? [3] : [...new Set([description.batch, 1])];
    const observations = [];
    for (const batchSize of batches)
      for (const concurrency of new Set([description.concurrency, 1])) {
        const execution = CollectionExecution.make({ batchSize, concurrency });
        const run = yield* makeBatchTransport(records, description.ledger, batchSize, concurrency);
        const child = yield* Taxonomy.partitionRecordsByMembership(records, target, {
          execution,
        }).pipe(
          Effect.provide(run.layer),
          Effect.onExit(() => Effect.sync(run.settle)),
          Effect.forkChild,
        );
        const partition = yield* Effect.gen(function* () {
          yield* driveBatchSchedule(
            run,
            concurrency,
            run.slots.length,
            description.choices,
            "partition-refills",
          );
          return yield* Fiber.join(child);
        }).pipe(Effect.ensuring(Fiber.interrupt(child)));
        const quantifiers = [];
        for (const kind of ["all", "any", "none"] satisfies Quantifier[]) {
          const scan = yield* makeBatchTransport(
            records,
            description.ledger,
            batchSize,
            concurrency,
          );
          const terminal = terminalIndex(description.ledger, kind);
          const reached =
            terminal < 0
              ? scan.slots.length
              : Math.min(
                  scan.slots.length,
                  Math.ceil((terminal + 1) / (batchSize * concurrency)) * concurrency,
                );
          const fiber = yield* quantify[kind](records, target, { execution }).pipe(
            Effect.provide(scan.layer),
            Effect.onExit(() => Effect.sync(scan.settle)),
            Effect.forkChild,
          );
          const actual = yield* Effect.gen(function* () {
            yield* driveBatchSchedule(
              scan,
              concurrency,
              reached,
              description.choices,
              "quantifier-window-barrier",
            );
            return yield* Fiber.join(fiber);
          }).pipe(Effect.ensuring(Fiber.interrupt(fiber)));
          quantifiers.push({ kind, actual, transport: scan.observe() });
        }
        observations.push({ partition, transport: run.observe(), quantifiers });
      }
    return observations;
  });
}

/** Reach a fault after neutral progress and possibly decisive siblings; observe from the parent. */
function observeReachedFault(description: FaultDescription) {
  return Effect.gen(function* () {
    const { batch, concurrency, kind, fault } = description;
    const prior = description.priorWindow ? concurrency : 0;
    const faultRank = prior + concurrency - 1;
    const records = specimens((faultRank + 1) * batch + 1, false);
    const neutral = kind === "any" || kind === "none" ? "notMember" : "member";
    const ledger: Label[] = records.map((_, index) =>
      index >= prior * batch && index < faultRank * batch
        ? kind === "all"
          ? "notMember"
          : "member"
        : neutral,
    );
    const run = yield* makeBatchTransport(
      records,
      ledger,
      batch,
      concurrency,
      fault === "interrupt" ? undefined : { rank: faultRank, kind: fault },
    );
    const execution = CollectionExecution.make({ batchSize: batch, concurrency });
    const operation =
      kind === "partition"
        ? Taxonomy.partitionRecordsByMembership(records, target, { execution }).pipe(Effect.asVoid)
        : kind === "group"
          ? Taxonomy.groupRecordsByTaxa(records, [target, TaxonName.make("unreached target")], {
              execution,
            }).pipe(Effect.asVoid)
          : quantify[kind](records, target, { execution }).pipe(Effect.asVoid);
    const child = yield* operation.pipe(
      Effect.provide(run.layer),
      Effect.onExit(() => Effect.sync(run.settle)),
      Effect.forkChild,
    );
    return yield* Effect.gen(function* () {
      if (prior > 0)
        yield* driveBatchSchedule(
          run,
          concurrency,
          prior,
          [true],
          kind === "partition" || kind === "group"
            ? "partition-refills"
            : "quantifier-window-barrier",
        );
      for (let rank = prior; rank <= faultRank; rank++)
        yield* Deferred.await(at(run.slots, rank).started);
      for (let rank = prior; rank < faultRank; rank++) yield* answerBatch(run, rank);
      const faultWasActive = at(run.slots, faultRank).active;
      if (fault === "interrupt") yield* Fiber.interrupt(child);
      else yield* Deferred.succeed(at(run.slots, faultRank).release, undefined);
      const exit = yield* Fiber.await(child);
      const atExit = run.observe();
      yield* Effect.yieldNow;
      return { faultWasActive, exit, atExit, afterTurn: run.observe() };
    }).pipe(Effect.ensuring(Fiber.interrupt(child)));
  });
}

/** A and B are independent children, not fail-fast siblings in a concurrent traversal. */
function runIndependentExecutions(
  description: IsolationDescription,
  fixture: {
    readonly recordsA: readonly Specimen[];
    readonly recordsB: readonly Specimen[];
    readonly originalLedger: readonly Label[];
    readonly freshLedger: readonly Label[];
  },
) {
  return Effect.gen(function* () {
    const { concurrencyA, concurrencyB, abort, ledgerB } = description;
    const { recordsA, recordsB, originalLedger, freshLedger } = fixture;
    const operationA = Taxonomy.partitionRecordsByMembership(recordsA, target, {
      execution: CollectionExecution.make({ batchSize: 1, concurrency: concurrencyA }),
    });
    const a = yield* makeBatchTransport(
      recordsA,
      originalLedger,
      1,
      concurrencyA,
      abort === "failure" ? { rank: 1, kind: abort } : undefined,
    );
    const b = yield* makeBatchTransport(recordsB, ledgerB, 1, concurrencyB);
    const fiberA = yield* operationA.pipe(
      Effect.provide(a.layer),
      Effect.onExit(() => Effect.sync(a.settle)),
      Effect.forkChild,
    );
    const fiberB = yield* Taxonomy.partitionRecordsByMembership(recordsB, target, {
      execution: CollectionExecution.make({ batchSize: 1, concurrency: concurrencyB }),
    }).pipe(
      Effect.provide(b.layer),
      Effect.onExit(() => Effect.sync(b.settle)),
      Effect.forkChild,
    );
    return yield* Effect.gen(function* () {
      yield* Deferred.await(at(b.slots, 0).started);
      yield* Deferred.await(at(a.slots, 0).started);
      yield* answerBatch(a, 0);
      yield* Deferred.await(at(a.slots, 1).started);
      const aHadProgress = a.finished.includes(0);
      const bWasActive = at(b.slots, 0).active;
      if (abort === "interrupt") yield* Fiber.interrupt(fiberA);
      else yield* Deferred.succeed(at(a.slots, 1).release, undefined);
      const exitA = yield* Fiber.await(fiberA);
      const aAtExit = a.observe();
      // Only now release B: A's failure must not have canceled this independent child.
      yield* driveBatchSchedule(
        b,
        concurrencyB,
        b.slots.length,
        [true, false],
        "partition-refills",
      );
      const exitB = yield* Fiber.await(fiberB);
      const bAtExit = b.observe();
      const rerun = yield* makeBatchTransport(recordsA, freshLedger, 1, concurrencyA);
      // Reuse the identical Effect with a new provider: cached answers or mutable run
      // state from A would disagree with the root's deliberately different fresh ledger.
      const fresh = yield* operationA.pipe(
        Effect.provide(rerun.layer),
        Effect.onExit(() => Effect.sync(rerun.settle)),
        Effect.forkChild,
      );
      const rerunPartition = yield* Effect.gen(function* () {
        yield* Deferred.await(at(rerun.slots, 0).started);
        yield* driveBatchSchedule(
          rerun,
          concurrencyA,
          rerun.slots.length,
          [true],
          "partition-refills",
        );
        return yield* Fiber.join(fresh);
      }).pipe(Effect.ensuring(Fiber.interrupt(fresh)));
      return {
        aHadProgress,
        bWasActive,
        exitA,
        exitB,
        rerunPartition,
        aAtExit,
        bAtExit,
        rerun: rerun.observe(),
        aAfterRerun: a.observe(),
        bAfterRerun: b.observe(),
      };
    }).pipe(Effect.ensuring(Fiber.interrupt(fiberA)), Effect.ensuring(Fiber.interrupt(fiberB)));
  });
}

/** Abort the middle entry, then evaluate the identical Effect after mutating a shared target. */
function observeGroupingRestart(
  description: GroupDescription,
  fixture: {
    readonly records: readonly Specimen[];
    readonly expression: ReturnType<typeof TaxonSet.of>;
    readonly targets: readonly ReturnType<typeof TaxonSet.of>[];
    readonly freshName: TaxonName;
  },
) {
  return Effect.gen(function* () {
    const { batch, concurrency, abort } = description;
    const { records, expression, targets, freshName } = fixture;
    const operation = Taxonomy.groupRecordsByTaxa(records, targets, {
      execution: CollectionExecution.make({ batchSize: batch, concurrency }),
    });
    const first = yield* makeGroupTransport(records, batch, concurrency, abort);
    const child = yield* operation.pipe(
      Effect.provide(first.layer),
      Effect.onExit(() => Effect.sync(first.settle)),
      Effect.forkChild,
    );
    const failed = yield* Effect.gen(function* () {
      yield* Deferred.await(first.pending);
      const beforeAbort = first.observe();
      if (abort === "interrupt") yield* Fiber.interrupt(child);
      else yield* Deferred.succeed(first.releaseMiddle, undefined);
      const exit = yield* Fiber.await(child);
      const atExit = first.observe();
      yield* Effect.yieldNow;
      return { beforeAbort, exit, atExit, afterTurn: first.observe() };
    }).pipe(Effect.ensuring(Fiber.interrupt(child)));
    // Deliberate untyped-caller fixture, only between evaluations, as in the fixed regression.
    Object.assign(expression, { name: freshName });
    const fresh = yield* makeGroupTransport(records, batch, concurrency);
    const grouped = yield* operation.pipe(
      Effect.provide(fresh.layer),
      Effect.onExit(() => Effect.sync(fresh.settle)),
    );
    return {
      failed,
      grouped,
      fresh: fresh.observe(),
      firstAfterRerun: first.observe(),
    };
  });
}

// Batch provider and active-request scheduler. A fresh transport owns one execution's
// gates and logs. Facts identify source batches, never provider callback ordinal.
function response(answers: readonly Label[]): DecisionModel.ProviderResponse {
  return {
    answers: Object.fromEntries(
      answers.map((label, index) => [
        `record${index}`,
        {
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
        },
      ]),
    ),
    usage: { inputTokens: undefined, outputTokens: undefined },
  };
}

function providerFailure() {
  return AiError.make({
    module: "CollectionProperty",
    method: "decide",
    reason: new AiError.UnknownError({ description: "reached injected failure" }),
  });
}

/** Identify batches from encoded facts; duplicates require the B=3 sentinel rule above. */
function makeBatchTransport(
  records: readonly Specimen[],
  ledger: readonly Label[],
  batchSize: number,
  concurrency: number,
  fault?: { readonly rank: number; readonly kind: ProviderFault },
) {
  return Effect.gen(function* () {
    const slots = yield* Effect.forEach(
      Array.from({ length: Math.ceil(records.length / batchSize) }, (_, rank) => rank),
      (rank) =>
        Effect.gen(function* () {
          return {
            rank,
            started: yield* Deferred.make<void>(),
            release: yield* Deferred.make<void>(),
            finalized: yield* Deferred.make<void>(),
            active: false,
          };
        }),
    );
    const started: number[] = [];
    const finished: number[] = [];
    let active = 0;
    let settled = false;
    let attempts = 0;
    let lateAttempts = 0;
    // Record before assertions: even a late request that defects must leave evidence.
    const observeRequest = Effect.fnUntraced(function* (
      decisions: DecisionModel.ProviderOptions["decisions"],
    ) {
      attempts++;
      if (settled) lateAttempts++;
      const question = decisions.record0;
      if (question?._tag !== "Classify") return yield* Effect.die("Expected classification");
      const slot = slots.find(({ rank }) =>
        question.instructions.endsWith(
          `Scientific name: ${JSON.stringify(at(records, rank * batchSize).scientificName)}`,
        ),
      );
      if (slot === undefined) return yield* Effect.die("Unrecognized batch facts");
      expect(settled).toBe(false);
      expect(started).not.toContain(slot.rank);
      const batch = records.slice(slot.rank * batchSize, (slot.rank + 1) * batchSize);
      expect(Object.keys(decisions)).toEqual(batch.map((_, local) => `record${local}`));
      batch.forEach((record, local) =>
        expect(decisions[`record${local}`]).toMatchObject({
          instructions: expect.stringContaining(
            `Scientific name: ${JSON.stringify(record.scientificName)}`,
          ),
        }),
      );
      started.push(slot.rank);
      slot.active = true;
      expect(++active).toBeLessThanOrEqual(concurrency);
      return slot;
    });
    type Slot = (typeof slots)[number];
    const answerReleasedRequest = Effect.fnUntraced(function* (slot: Slot) {
      yield* Deferred.succeed(slot.started, undefined);
      yield* Deferred.await(slot.release);
      if (fault?.rank === slot.rank) {
        if (fault.kind === "failure") return yield* providerFailure();
        if (fault.kind === "invalid") return response([]);
        return yield* Effect.die("reached injected defect");
      }
      return response(ledger.slice(slot.rank * batchSize, (slot.rank + 1) * batchSize));
    });
    const finalizeRequest = Effect.fnUntraced(function* (slot: Slot) {
      slot.active = false;
      active--;
      finished.push(slot.rank);
      yield* Deferred.succeed(slot.finalized, undefined);
    });
    const layer = Layer.effect(
      DecisionModel.DecisionModel,
      DecisionModel.make({
        decide: Effect.fnUntraced(function* ({ decisions }) {
          const slot = yield* observeRequest(decisions);
          return yield* answerReleasedRequest(slot).pipe(Effect.ensuring(finalizeRequest(slot)));
        }),
      }),
    );
    return {
      slots,
      layer,
      started,
      finished,
      settle: () => {
        settled = true;
      },
      isSettled: () => settled,
      observe: () => ({
        lateAttempts,
        attempts,
        active,
        started: [...started],
        finished: [...finished],
      }),
    };
  });
}

type BatchTransport = Effect.Success<ReturnType<typeof makeBatchTransport>>;
type SchedulingPolicy = "partition-refills" | "quantifier-window-barrier";

/** Complete only an active request; its finalizer must finish before the next driver step. */
function answerBatch(run: BatchTransport, rank: number) {
  return Effect.gen(function* () {
    const slot = at(run.slots, rank);
    expect(slot.active).toBe(true);
    yield* Deferred.succeed(slot.release, undefined);
    yield* Deferred.await(slot.finalized);
  });
}

/** First/last choices apply to active gates, not arbitrary not-yet-started slots.
 * Partitions refill a freed slot; quantifiers must finish the whole current window
 * before opening another, so their driver keeps partially completed windows closed.
 */
function driveBatchSchedule(
  run: BatchTransport,
  concurrency: number,
  reached: number,
  choices: readonly boolean[],
  policy: SchedulingPolicy,
) {
  return Effect.gen(function* () {
    let next = 0;
    let completed = 0;
    let step = 0;
    const pending: number[] = [];
    while (completed < reached) {
      const limit =
        policy === "quantifier-window-barrier"
          ? Math.min(reached, Math.floor(completed / concurrency + 1) * concurrency)
          : Math.min(reached, completed + concurrency);
      while (next < limit) {
        yield* Deferred.await(at(run.slots, next).started);
        pending.push(next++);
      }
      const position = at(choices, step++ % choices.length) ? pending.length - 1 : 0;
      const rank = at(pending, position);
      pending.splice(position, 1);
      yield* answerBatch(run, rank);
      completed++;
      if (policy === "quantifier-window-barrier" && pending.length > 0) {
        expect(run.started.length).toBe(limit);
        expect(run.isSettled()).toBe(false);
      }
    }
  });
}

// Group provider: target entries are sequential, with concurrency only inside an
// entry. Hold every active middle request until failure/cancellation is triggered;
// count all finalizers so a failed group cannot leave those requests running.
const namedState = Schema.Struct({
  nodes: Schema.Tuple([Schema.Struct({ _tag: Schema.Literal("Taxon"), name: Schema.String })]),
  target: Schema.Literal(0),
});

function makeGroupTransport(
  records: readonly Specimen[],
  batch: number,
  concurrency: number,
  abort?: "failure" | "interrupt",
) {
  return Effect.gen(function* () {
    const pending = yield* Deferred.make<void>();
    const releaseMiddle = yield* Deferred.make<void>();
    const seen: string[] = [];
    let active = 0;
    let finalized = 0;
    let middleStarted = 0;
    let settled = false;
    let attempts = 0;
    let lateAttempts = 0;
    let activeName: string | undefined;
    const observeTargetRequest = Effect.fnUntraced(function* (
      state: DecisionModel.ProviderOptions["state"],
    ) {
      // Record before decoding/assertions so a late callback defect cannot hide an attempt.
      attempts++;
      if (settled) lateAttempts++;
      const {
        nodes: [node],
      } = yield* Schema.decodeUnknownEffect(namedState)(state).pipe(Effect.orDie);
      expect(settled).toBe(false);
      seen.push(node.name);
      if (active > 0) expect(node.name).toBe(activeName);
      activeName = node.name;
      expect(++active).toBeLessThanOrEqual(concurrency);
      return node.name;
    });
    const answerTargetRequest = Effect.fnUntraced(function* (
      name: string,
      decisions: DecisionModel.ProviderOptions["decisions"],
    ) {
      if (abort !== undefined && name === "middle") {
        if (++middleStarted === Math.min(concurrency, Math.ceil(records.length / batch)))
          yield* Deferred.succeed(pending, undefined);
        yield* Deferred.await(releaseMiddle);
        const question = decisions.record0;
        if (question?._tag !== "Classify") return yield* Effect.die("Expected classification");
        if (
          abort === "failure" &&
          question.instructions.endsWith(
            `Scientific name: ${JSON.stringify(at(records, 0).scientificName)}`,
          )
        )
          return yield* providerFailure();
        return yield* Effect.never;
      }
      // Give an incorrectly concurrent later entry a chance to become observable.
      yield* Effect.yieldNow;
      return response(Object.keys(decisions).map(() => "multipleTarget0"));
    });
    const finalizeRequest = Effect.sync(() => {
      active--;
      finalized++;
    });
    const layer = Layer.effect(
      DecisionModel.DecisionModel,
      DecisionModel.make({
        decide: Effect.fnUntraced(function* ({ state, decisions }) {
          const name = yield* observeTargetRequest(state);
          return yield* answerTargetRequest(name, decisions).pipe(Effect.ensuring(finalizeRequest));
        }),
      }),
    );
    return {
      layer,
      pending,
      releaseMiddle,
      seen,
      settle: () => {
        settled = true;
      },
      observe: () => ({ lateAttempts, attempts, active, finalized, seen: [...seen] }),
    };
  });
}
