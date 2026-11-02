import { Array, Match, Option, Schema } from "effect";
import { panels, records } from "./catalog.ts";
import { MatchJudgment, type PanelResponse } from "./contract.ts";

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
  readonly response: PanelResponse;
  readonly findings: PanelFindings;
  readonly matchedRecords: number;
  readonly comparison: typeof Comparison.Type;
}

/** Publish a new response, retaining the display unchanged for the same response object. */
export const replaceDisplayed = (
  previous: Display | undefined,
  response: PanelResponse,
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

/** Shared labels, semantic colors, and strongest-judgment priority for every view. */
export const judgmentPresentation = MatchJudgment.match({
  Matched: () => ({ label: "Matches", priority: 2, style: { color: "var(--color-matched)" } }),
  Undetermined: () => ({
    label: "Uncertain",
    priority: 1,
    style: { color: "var(--color-uncertain)" },
  }),
  NotMatched: () => ({
    label: "No match",
    priority: 0,
    style: { color: "var(--color-unmatched)" },
  }),
});

const panelFindings = (response: PanelResponse) => {
  const panel = Option.getOrThrow(
    Array.findFirst(panels, (entry) => entry.id === response.panelId),
  );
  const findings = response.rows.map((row) => ({
    record: Option.getOrThrow(Array.findFirst(records, (record) => record.id === row.recordId)),
    acceptedTargets: new Set(
      row.matches
        .filter((match) => MatchJudgment.guards.Matched(match.judgment))
        .map((match) => match.targetId),
    ),
    judgment: row.matches.reduce(
      (judgment: MatchJudgment, match) =>
        judgmentPresentation(match.judgment).priority > judgmentPresentation(judgment).priority
          ? match.judgment
          : judgment,
      MatchJudgment.cases.NotMatched.make({}),
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
/** One response row with resolved targets, accepted IDs, and its strongest judgment. */
export type RecordFinding = PanelFindings["records"][number];
/** Accepted record shares and cumulative offsets, both in percentage points (0–100). */
export type TargetComposition = PanelFindings["compositions"][number];
