import { Array, Match, Option, Schema } from "effect";
import { TaxonMatchJudgment } from "robo-taxonomist";
import { panels, records } from "./catalog.ts";
import * as Contract from "./contract.ts";

const percent = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 2 });
const sampleWeight = records.reduce((sum, record) => sum + record.abundance, 0);

/** Format a unit fraction as a percentage with at most two decimal places. */
export const formatPercent = (fraction: number): string => percent.format(fraction);
/** Format a record's weight as a share of the fixed sample's total weight. */
export const formatSampleShare = (weight: number): string => formatPercent(weight / sampleWeight);

/** Describe the catalog input's resolution, independently of any model judgment. */
export const recordKindLabel = Match.type<(typeof records)[number]["kind"]>().pipe(
  Match.when("vague", () => "Unresolved name"),
  Match.when("genus", () => "Genus-only record"),
  Match.when("species", () => "Species record"),
  Match.exhaustive,
);

/** Compare accepted target sets, not support probabilities or answer wording. */
export const Comparison = Schema.TaggedUnion({
  FirstDisplay: {},
  Compared: { panelName: Schema.String, changedRecords: Schema.Int },
});

/** One published response and its derived findings; response identity is preserved. */
export interface Display {
  readonly response: Contract.PanelResponse;
  readonly findings: PanelFindings;
  readonly matchedRecords: number;
  readonly comparison: typeof Comparison.Type;
}

/** Publish a new response, retaining the display unchanged for the same response object. */
export const replaceDisplayed = (
  previous: Display | undefined,
  response: Contract.PanelResponse,
): Display => {
  if (previous?.response === response) return previous;
  const findings = panelFindings(response);
  const comparison = Option.match(Option.fromUndefinedOr(previous), {
    onNone: () => Comparison.cases.FirstDisplay.make({}),
    onSome: (display) => {
      let changedRecords = 0;
      for (const { record, acceptedTargets: targets } of findings.records) {
        const earlier = Option.getOrThrow(
          Array.findFirst(display.findings.records, (entry) => entry.record.id === record.id),
        ).acceptedTargets;
        if (earlier.size !== targets.size || ![...targets].every((id) => earlier.has(id))) {
          changedRecords++;
        }
      }
      return Comparison.cases.Compared.make({
        panelName: display.findings.panel.name,
        changedRecords,
      });
    },
  });
  return {
    response,
    findings,
    matchedRecords: findings.records.filter((entry) => entry.acceptedTargets.size > 0).length,
    comparison,
  };
};

/** Per-target accepted relationship and its support, when available. */
export const judgmentPresentation = TaxonMatchJudgment.match({
  SameTaxon: ({ support }) => ({
    label: "Same taxon",
    support,
    style: { color: "var(--color-matched)" },
  }),
  WithinTaxon: ({ support }) => ({
    label: "Within target taxon",
    support,
    style: { color: "var(--color-matched)" },
  }),
  Undetermined: () => ({
    label: "Unresolved",
    support: undefined,
    style: { color: "var(--color-uncertain)" },
  }),
  NotMatched: ({ support }) => ({
    label: "Not a match",
    support,
    style: { color: "var(--color-unmatched)" },
  }),
});

const panelFindings = (response: Contract.PanelResponse) => {
  const panel = Option.getOrThrow(
    Array.findFirst(panels, (entry) => entry.id === response.panelId),
  );
  const findings = response.rows.map((row) => ({
    record: Option.getOrThrow(Array.findFirst(records, (record) => record.id === row.recordId)),
    acceptedTargets: new Set(
      row.matches
        .filter(
          (match) =>
            TaxonMatchJudgment.guards.SameTaxon(match.judgment) ||
            TaxonMatchJudgment.guards.WithinTaxon(match.judgment),
        )
        .map((match) => match.targetId),
    ),
    matches: row.matches.map((match) => ({
      ...match,
      target: Option.getOrThrow(
        Array.findFirst(panel.targets, (target) => target.id === match.targetId),
      ),
    })),
  }));
  const compositions = panel.targets.map((target) => {
    let abundance = 0;
    const contributors = findings
      .filter((entry) => entry.acceptedTargets.has(target.id))
      .map(({ record }) => {
        const share = (record.abundance / sampleWeight) * 100;
        const contributor = {
          id: record.id,
          name: record.name,
          abundance: share,
          offset: abundance,
        };
        abundance += share;
        return contributor;
      });
    return { ...target, abundance, contributors };
  });
  return {
    panel,
    response,
    records: findings,
    compositions,
  };
};

/** Catalog-resolved response with accepted sets and catalog-ordered composition segments. */
export type PanelFindings = ReturnType<typeof panelFindings>;
/** One response row with resolved targets and accepted IDs. */
export type RecordFinding = PanelFindings["records"][number];
/** Accepted record shares and cumulative offsets, both in percentage points (0–100). */
export type TargetComposition = PanelFindings["compositions"][number];
