import * as Decision from "effect/ai/Decision";
import * as DecisionModel from "effect/ai/DecisionModel";
import * as Array from "effect/Array";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Iterable from "effect/Iterable";
import * as Match from "effect/Match";
import * as Order from "effect/Order";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as AcceptancePolicy from "../AcceptancePolicy.ts";
import type { TaxonSet } from "../TaxonSet.ts";
import * as Errors from "../errors.ts";
import { TaxonomicRecord, Taxon, TaxonomyHint, type CollectionOptions } from "../schemas.ts";
import * as TaxonSetGraph from "../TaxonSetGraph.ts";
import * as TaxonomyHints from "../TaxonomyHints.ts";
import {
  defaultCollectionExecution,
  describeRecord,
  recordInputSchema,
  type RecordInput,
} from "./RecordInput.ts";

/**
 * Construct or validate a classification judgment with its accepted answer's support.
 * Undetermined reports no accepted classification and carries no accepted support.
 *
 * @category schemas
 * @since 0.5.0
 * @see {@link TaxonMatch} for saving a classification result.
 * @example
 * import { TaxonMatchJudgment } from "robo-taxonomist";
 * export const within = TaxonMatchJudgment.cases.WithinTaxon.make({ support: 0.97 });
 */
export const TaxonMatchJudgment = Schema.TaggedUnion({
  SameTaxon: { support: AcceptancePolicy.UnitInterval },
  WithinTaxon: { support: AcceptancePolicy.UnitInterval },
  NotMatched: { support: AcceptancePolicy.UnitInterval },
  Undetermined: {},
});

/**
 * Report an accepted relationship, an accepted negative answer, or no accepted classification.
 * NotMatched requires an accepted model-selected noMatch answer.
 *
 * @category models
 * @since 0.2.0
 * @see {@link TaxonMatch} for saving a classification result.
 */
export type TaxonMatchJudgment = typeof TaxonMatchJudgment.Type;

const taxonMatchCriteria = {
  sameTaxon: "A match: the record identifies this taxon, including resolved synonyms.",
  withinTaxon: "A match: the record identifies taxa classified within this broader taxon.",
  noMatch: "The supplied identification or panel expression rules out this classification.",
  undetermined: "The supplied information does not establish whether this classification is valid.",
};

type TaxonMatchAnswer = Decision.ClassifyAnswer<keyof typeof taxonMatchCriteria>;

const matchAnswerSchema = Schema.Struct({
  label: Schema.Literals(Record.keys(taxonMatchCriteria)),
  probabilities: Schema.Struct({
    sameTaxon: AcceptancePolicy.UnitInterval,
    withinTaxon: AcceptancePolicy.UnitInterval,
    noMatch: AcceptancePolicy.UnitInterval,
    undetermined: AcceptancePolicy.UnitInterval,
  }),
  confidence: Schema.optionalKey(AcceptancePolicy.UnitInterval),
});

/**
 * Save a match returned by `classifyRecords`. Pass the schemas for your input
 * and target records to keep fields like voucher IDs and catalog IDs alongside
 * the match. When you load it, use `TaxonSet.of(loaded.taxon.record)` if you want
 * to ask a new question about that target.
 *
 * The answer records what the model reported; the judgment records what the
 * policy accepted. If the model selects `sameTaxon` at 0.60 and the minimum is
 * 0.80, saving the `Undetermined` judgment still keeps the original answer.
 * The schema checks that all four scores and any supplied confidence are finite
 * numbers in [0, 1]. Loading does not change the scores, choose a label, or
 * apply the policy again.
 *
 * @category schemas
 * @since 0.7.0
 * @param record - Schema for the original record label or taxonomic record.
 * @param targetRecord - Schema for the record carried by the taxon node.
 * @see {@link TaxonMatchJudgment}
 * @example
 * import { Effect, Schema } from "effect";
 * import { TaxonName, TaxonSet, Taxonomy } from "robo-taxonomist";
 *
 * const Specimen = Schema.Struct({
 *   scientificName: TaxonName,
 *   voucherId: Schema.String,
 * });
 * const CatalogTarget = Schema.Struct({
 *   scientificName: TaxonName,
 *   catalogId: Schema.String,
 * });
 * const specimen = Specimen.make({
 *   scientificName: TaxonName.make("Quercus robur"),
 *   voucherId: "A17",
 * });
 * const target = TaxonSet.of(CatalogTarget.make({
 *   scientificName: TaxonName.make("Quercus"),
 *   catalogId: "oaks",
 * }));
 *
 * const Match = Taxonomy.TaxonMatch(Specimen, CatalogTarget);
 * const MatchJson = Schema.fromJsonString(Schema.toCodecJson(Match));
 *
 * const roundTrip = Effect.gen(function* () {
 *   const result = yield* Taxonomy.classifyRecords([specimen], target);
 *   const matches = result.records.flatMap((row) => row.taxa);
 *
 *   return yield* Effect.forEach(matches, (match) => Effect.gen(function* () {
 *     const saved = yield* Schema.encodeUnknownEffect(MatchJson)(match);
 *     return yield* Schema.decodeEffect(MatchJson)(saved);
 *   }));
 * });
 */
export const TaxonMatch = <
  R extends Schema.Schema<RecordInput>,
  T extends Schema.Schema<TaxonomicRecord>,
>(
  record: R,
  targetRecord: T,
) =>
  Schema.Struct({
    record,
    taxon: Schema.TaggedStruct("Taxon", { record: targetRecord }),
    judgment: TaxonMatchJudgment,
    answer: matchAnswerSchema,
  });

class TaxonMatchValue<
  R extends RecordInput,
  T extends TaxonomicRecord = TaxonomicRecord,
> extends Data.Class<{
  readonly record: R;
  readonly taxon: Taxon<T>;
  readonly judgment: TaxonMatchJudgment;
  readonly answer: TaxonMatchAnswer;
}> {}

/**
 * Keep an original record and taxon node with their scored match judgment.
 * Accepted judgments carry the selected answer's support as a finite number in [0, 1].
 * The complete validated model answer is retained without modification.
 * The record's concrete type and caller metadata remain available through R.
 *
 * @category models
 * @since 0.2.0
 */
export type TaxonMatch<
  R extends RecordInput,
  T extends TaxonomicRecord = TaxonomicRecord,
> = TaxonMatchValue<R, T>;

const isPositiveMatch = Predicate.Struct({
  judgment: TaxonMatchJudgment.isAnyOf(["SameTaxon", "WithinTaxon"]),
});

const taxonMatchInstructions =
  "Assess whether each record can be classified under each supplied taxon. " +
  "A match requires the same taxon, including resolved synonyms, " +
  "or classification within a broader taxon. Several taxa can match. " +
  "Each target identifies one taxonomic entity; choose undetermined when a target identifies multiple entities.";

const taxonMatchInputSchema = Schema.Struct({
  instructions: Schema.String,
  hints: Schema.optionalKey(Schema.NonEmptyArray(TaxonomyHint)),
  records: Schema.Array(Schema.String),
  taxa: Schema.Array(TaxonomicRecord),
  nodes: TaxonSetGraph.membershipTargetSchema.fields.nodes,
  panel: Schema.Natural,
});

const interpretTaxonMatch = Match.fn(
  (answer: TaxonMatchAnswer, _policy: AcceptancePolicy.AcceptancePolicy) => answer,
).pipe(
  Match.when({ label: "sameTaxon" }, ({ probabilities: p }, _answer, policy) => {
    const support = p.sameTaxon;
    const competitorSupport = Math.max(p.withinTaxon, p.noMatch, p.undetermined);

    return AcceptancePolicy.accepts(support, competitorSupport, policy)
      ? TaxonMatchJudgment.cases.SameTaxon.make({ support })
      : TaxonMatchJudgment.cases.Undetermined.make({});
  }),
  Match.when({ label: "withinTaxon" }, ({ probabilities: p }, _answer, policy) => {
    const support = p.withinTaxon;
    const competitorSupport = Math.max(p.sameTaxon, p.noMatch, p.undetermined);

    return AcceptancePolicy.accepts(support, competitorSupport, policy)
      ? TaxonMatchJudgment.cases.WithinTaxon.make({ support })
      : TaxonMatchJudgment.cases.Undetermined.make({});
  }),
  Match.when({ label: "noMatch" }, ({ probabilities: p }, _answer, policy) => {
    const support = p.noMatch;
    const competitorSupport = Math.max(p.sameTaxon, p.withinTaxon, p.undetermined);

    return AcceptancePolicy.accepts(support, competitorSupport, policy)
      ? TaxonMatchJudgment.cases.NotMatched.make({ support })
      : TaxonMatchJudgment.cases.Undetermined.make({});
  }),
  Match.when({ label: "undetermined" }, () => TaxonMatchJudgment.cases.Undetermined.make({})),
  Match.exhaustive,
);

const makeTaxonMatch = <R extends RecordInput, T extends TaxonomicRecord>(
  record: R,
  taxon: Taxon<T>,
  answer: TaxonMatchAnswer,
  policy: AcceptancePolicy.AcceptancePolicy,
) => {
  const judgment = interpretTaxonMatch(answer, policy);

  return new TaxonMatchValue({ record, taxon, judgment, answer });
};

const taxaOf = <T extends TaxonomicRecord>(panel: TaxonSet<T>) => {
  const taxa: Taxon<T>[] = [];
  const emptyIncluded = new WeakSet<TaxonSet<T>>();
  const emptyExcluded = new WeakSet<TaxonSet<T>>();

  const pending: {
    readonly expression: TaxonSet<T>;
    readonly include: boolean;
    readonly start?: number;
  }[] = [{ expression: panel, include: true }];

  while (pending.length > 0) {
    const next = pending.pop();

    if (next === undefined) break;
    const { expression, include, start } = next;
    const empty = include ? emptyIncluded : emptyExcluded;

    if (empty.has(expression)) continue;

    if (start !== undefined) {
      // Productive shared subtrees retain every original occurrence.
      if (taxa.length === start) empty.add(expression);
      continue;
    }

    pending.push({ expression, include, start: taxa.length });
    Match.value(expression).pipe(
      Match.tagsExhaustive({
        Empty: () => {},
        Taxon: (taxon) => {
          if (include) taxa.push(taxon);
        },
        Union: ({ operands }) => {
          for (let index = operands.length - 1; index >= 0; index--) {
            pending.push({ expression: Array.getUnsafe(operands, index), include });
          }
        },
        Intersection: ({ operands }) => {
          for (let index = operands.length - 1; index >= 0; index--) {
            pending.push({ expression: Array.getUnsafe(operands, index), include });
          }
        },
        Difference: ({ left, right }) => {
          pending.push({ expression: right, include: !include });
          pending.push({ expression: left, include });
        },
      }),
    );
  }

  return taxa;
};

type ClassifyRecordsFn = <R extends RecordInput, T extends TaxonomicRecord = TaxonomicRecord>(
  records: readonly R[],
  panel: TaxonSet<T>,
  options?: CollectionOptions,
) => Effect.Effect<
  {
    readonly panel: TaxonSet<T>;
    readonly records: readonly {
      readonly record: R;
      readonly taxa: readonly TaxonMatch<R, T>[];
      readonly ranking: readonly TaxonMatch<R, T>[];
    }[];
    readonly usage: readonly DecisionModel.DecisionUsage[];
  },
  Errors.TaxonomyError,
  DecisionModel.DecisionModel
>;

/**
 * Rank supported taxonomic matches for each record against a panel expression.
 * Accept the model-selected relationship using its individual support and margin.
 * SameTaxon and WithinTaxon establish positive classifications; NotMatched accepts noMatch.
 * Undetermined reports no accepted classification while retaining the complete scored answer.
 * Several taxa can match. Each record's taxa retains all outcomes in supplied
 * occurrence order; ranking contains accepted positive relationships in descending support order.
 * Ties retain occurrence order. Original records, metadata and taxon nodes are preserved.
 * Subtraction removes taxon occurrences from ranking options; nested subtraction can restore them.
 * Every question receives the complete panel expression.
 *
 * Uses the existing record batch size and concurrency options. Empty records or
 * a panel offering no taxa produce empty rankings without a model call.
 * A failed request fails the complete operation. Support describes model judgments,
 * not sequence-abundance fractions or a preference for a particular taxonomic rank.
 *
 * @category collections
 * @since 0.2.0
 * @example
 * import { Effect } from "effect";
 * import { TaxonName, TaxonSet, Taxonomy } from "robo-taxonomist";
 * const records = [{ scientificName: TaxonName.make("Quercus robur"), abundance: 8 }];
 * const panel = TaxonSet.union(
 *   TaxonSet.of(TaxonName.make("Quercus")),
 *   TaxonSet.of(TaxonName.make("Quercus robur")),
 * );
 * export const ranked = Effect.gen(function* () {
 *   const result = yield* Taxonomy.classifyRecords(records, panel);
 *   return result.records.map(row => row.ranking.map(match => match.taxon.record.scientificName));
 * });
 */
export const classifyRecords: ClassifyRecordsFn = Effect.fn("Taxonomy.classifyRecords")(function* <
  R extends RecordInput,
  T extends TaxonomicRecord,
>(records: readonly R[], panel: TaxonSet<T>, options: CollectionOptions = {}) {
  const inherited = yield* TaxonomyHints.Current;
  const selected = options.hints === undefined ? inherited : options.hints;
  const snapshot = Array.isArray(selected) ? Array.copy(selected) : selected;
  const graph = yield* TaxonSetGraph.compile({ panel });

  if (records.length === 0) return { panel, records: [], usage: [] };
  const panelTaxa = taxaOf(panel);

  if (panelTaxa.length === 0) {
    return {
      panel,
      records: records.map((record) => ({ record, taxa: [], ranking: [] })),
      usage: [],
    };
  }

  const hints = yield* Schema.decodeUnknownEffect(Schema.Array(TaxonomyHint))(snapshot).pipe(
    Effect.mapError(Errors.InvalidInput.from),
  );

  const policy = options.policy ?? AcceptancePolicy.defaultPolicy;
  const execution = options.execution ?? defaultCollectionExecution;

  const classifyBatch = Effect.fnUntraced(function* (batch: readonly R[]) {
    const encoded = yield* Schema.encodeEffect(Schema.Array(recordInputSchema))(batch).pipe(
      Effect.mapError(Errors.InvalidInput.from),
    );

    const rows = batch.map((record, row) => ({
      record,
      taxa: panelTaxa.map((taxon, column) => ({
        taxon,
        key: `r${row}t${column}` as const,
        decision: Decision.classify({
          instructions:
            `Apply instructions. Classify records[${row}] under taxa[${column}], ` +
            "using the expression rooted at nodes[panel].",
          criteria: taxonMatchCriteria,
        }),
      })),
    }));

    const definition = Decision.make({
      input: Schema.toEncoded(taxonMatchInputSchema),
      decisions: Record.fromEntries(
        rows.flatMap((row) => row.taxa.map(({ key, decision }) => [key, decision] as const)),
      ),
    });

    const encodedTaxa = yield* Schema.encodeEffect(Schema.Array(TaxonomicRecord))(
      panelTaxa.map((taxon) => taxon.record),
    ).pipe(Effect.mapError(Errors.InvalidInput.from));

    const preparedInput = {
      instructions: taxonMatchInstructions,
      records: encoded.map(describeRecord),
      taxa: encodedTaxa,
      nodes: graph.nodes,
      panel: graph.roots.panel,
    };

    const input = Array.match(hints, {
      onEmpty: () => preparedInput,
      onNonEmpty: (nonempty) =>
        Struct.assign(preparedInput, {
          hints: nonempty,
          instructions:
            taxonMatchInstructions + "\nUse the supplied taxonomic hints as background.",
        }),
    });

    const response = yield* DecisionModel.decide(definition, { input });

    const classified = rows.map((row) => {
      const taxa = row.taxa.map(({ taxon, key }) => {
        const answer = Struct.get(response.answers, key);

        return makeTaxonMatch(row.record, taxon, answer, policy);
      });

      const accepted = taxa.filter((match) => isPositiveMatch(match));

      const ranking = Array.sort(
        accepted,
        Order.Struct({ judgment: Order.Struct({ support: Order.flip(Order.Number) }) }),
      );

      return { record: row.record, taxa, ranking };
    });

    return { records: classified, usage: response.usage };
  });

  const completed = yield* Effect.forEach(
    Iterable.chunksOf(records, execution.batchSize),
    classifyBatch,
    { concurrency: execution.concurrency },
  );

  return {
    panel,
    records: completed.flatMap((batch) => batch.records),
    usage: completed.map((batch) => batch.usage),
  };
});
