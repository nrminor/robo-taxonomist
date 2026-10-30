import { Tooltip } from "@base-ui/react/tooltip";
import { useAtomValue } from "@effect/atom-react";
import { Array, Match, Option, Schema } from "effect";
import { useReducer, useSyncExternalStore, type TransitionEvent } from "react";
import { recordSelectionAtom } from "../client/panel-atoms.ts";
import { panels, records } from "../lib/catalog.ts";
import { MatchJudgment } from "../lib/contract.ts";
import {
  formatPercent,
  formatSampleShare,
  judgmentPresentation,
  type PanelFindings,
  type RecordFinding,
  type TargetComposition,
} from "../lib/display.ts";
import styles from "./abundance-chart.module.css";

const RowPhase = Schema.Literals(["hidden", "entering", "present", "exiting"]);
type RowPhase = typeof RowPhase.Type;

interface PresentedRow {
  readonly composition: TargetComposition;
  readonly findings: PanelFindings;
  readonly index: number;
  readonly phase: RowPhase;
}

interface Presentation {
  readonly revision: symbol;
  readonly findings: PanelFindings;
  readonly animate: boolean;
  readonly maximum: number;
  readonly rows: ReadonlyArray<PresentedRow>;
}

const targets = [
  ...new Map(
    panels.flatMap((panel) => panel.targets).map((target) => [target.id, target]),
  ).values(),
];
// All panels agree on relative target order. Keep the pool in that shared order:
// moving a mounted DOM node would interrupt its native CSS transitions.
const orderTargets = (): typeof targets => {
  const orderedTargets: typeof targets = [];
  const pendingTargets = new Set(targets);
  while (pendingTargets.size > 0) {
    const next = targets.find(
      (target) =>
        pendingTargets.has(target) &&
        panels.every((panel) => {
          const index = panel.targets.findIndex((entry) => entry.id === target.id);
          return (
            index < 0 ||
            panel.targets
              .slice(0, index)
              .every((entry) => orderedTargets.some((placed) => placed.id === entry.id))
          );
        }),
    );
    if (next === undefined) throw new Error("Panel target orders must be compatible");
    orderedTargets.push(next);
    pendingTargets.delete(next);
  }
  return orderedTargets;
};
const orderedTargets = orderTargets();
const ticks = [0, 25, 50, 75, 100];

const present = (
  findings: PanelFindings,
  animate: boolean,
  revision: symbol,
  previous?: Presentation,
): Presentation => {
  const { compositions } = findings;
  const history: ReadonlyArray<PresentedRow> =
    previous?.rows ??
    orderedTargets.map((target) => ({
      composition: { ...target, abundance: 0, contributors: [] },
      findings,
      index: 0,
      phase: "hidden",
    }));
  return {
    revision,
    findings,
    animate,
    maximum: Math.max(
      previous?.maximum ?? 40,
      ...compositions.map((target) => Math.ceil(target.abundance / 20) * 20),
    ),
    rows: history.map((row): PresentedRow => {
      const index = compositions.findIndex((composition) => composition.id === row.composition.id);
      const composition = compositions[index];
      if (composition === undefined)
        return {
          ...row,
          phase: animate && row.phase !== "hidden" ? "exiting" : "hidden",
        };
      return {
        composition,
        findings,
        index,
        phase: previous !== undefined && animate && row.phase === "hidden" ? "entering" : "present",
      };
    }),
  };
};

const rowActive = Match.type<RowPhase>().pipe(
  Match.when("hidden", () => false),
  Match.when("entering", () => true),
  Match.when("present", () => true),
  Match.when("exiting", () => false),
  Match.exhaustive,
);

const settledPhase = Match.type<RowPhase>().pipe(
  Match.when("hidden", (): RowPhase => "hidden"),
  Match.when("entering", (): RowPhase => "present"),
  Match.when("present", (): RowPhase => "present"),
  Match.when("exiting", (): RowPhase => "hidden"),
  Match.exhaustive,
);

interface PresentationInput {
  readonly revision: symbol;
  readonly findings: PanelFindings;
  readonly animate: boolean;
}

const initialPresentation = ({ findings, animate, revision }: PresentationInput): Presentation =>
  present(findings, animate, revision);

const reducePresentation = (
  current: Presentation,
  update: PresentationInput | { readonly settledTargetId: string },
): Presentation => {
  if ("findings" in update)
    return present(update.findings, update.animate, update.revision, current);
  const settled = current.rows.find((row) => row.composition.id === update.settledTargetId);
  if (settled === undefined || settledPhase(settled.phase) === settled.phase) return current;
  return {
    ...current,
    rows: current.rows.map((row) =>
      row === settled ? { ...row, phase: settledPhase(row.phase) } : row,
    ),
  };
};

const settlesAppearance = (event: TransitionEvent<HTMLElement>): boolean =>
  (event.target === event.currentTarget && event.propertyName === "opacity") ||
  (event.target === event.currentTarget.firstElementChild && event.propertyName === "transform");

const selectionStory = (selected: Option.Option<RecordFinding>, findings: PanelFindings): string =>
  Option.match(selected, {
    onNone: () => "Select a record to locate its segment in matching targets.",
    onSome: ({ record, matches, judgment }) =>
      MatchJudgment.match({
        Matched: () => {
          const count = matches.filter((match) =>
            MatchJudgment.guards.Matched(match.judgment),
          ).length;
          return `This record is ${formatSampleShare(record.abundance)} of the sample and matches ${count} target${count === 1 ? "" : "s"}. The same record is included in each matching total.`;
        },
        Undetermined: () => {
          const count = matches.filter((match) =>
            MatchJudgment.guards.Undetermined(match.judgment),
          ).length;
          return `There is not enough information to decide whether this record matches ${count} target${count === 1 ? "" : "s"}. It is not included in any target total in ${findings.panel.name}.`;
        },
        NotMatched: () =>
          `This record does not match any target in ${findings.panel.name}, so it is not included in any target total.`,
      })(judgment),
  });

const describeRow = (row: PresentedRow, selectedId: string | undefined, maximum: number) => {
  const target = row.composition;
  const selected =
    selectedId === undefined
      ? Option.none()
      : Array.findFirst(row.findings.records, (entry) => entry.record.id === selectedId);
  const selectedMatch = Option.flatMap(selected, (entry) =>
    Array.findFirst(entry.matches, (match) => match.target.id === target.id),
  );
  // Initially hidden pool rows need not belong to their retained panel. Every
  // painted row does, so missing findings there are an invariant failure.
  const match =
    selectedId !== undefined && row.phase !== "hidden"
      ? Option.getOrThrow(selectedMatch)
      : Option.getOrUndefined(selectedMatch);
  const contributes = target.contributors.some((entry) => entry.id === selectedId);
  const result = match === undefined ? undefined : judgmentPresentation(match.judgment);
  const judgment = result?.label ?? "Unavailable";
  const summary = `${formatPercent(target.abundance / 100)} of sample · ${target.contributors.length} matching record${target.contributors.length === 1 ? "" : "s"}`;
  const membership =
    selectedId === undefined
      ? ""
      : contributes
        ? " · selected record is included"
        : " · selected record is not included";
  const decision =
    selectedId === undefined
      ? ""
      : ` · ${judgment} · Match support: ${match === undefined ? "Unavailable" : formatPercent(match.support)}`;
  const composition =
    target.contributors.length === 0
      ? ""
      : ` · Records: ${target.contributors.map((entry) => `${entry.name} ${formatPercent(entry.abundance / 100)}`).join("; ")}`;
  return {
    target,
    active: rowActive(row.phase),
    contributes,
    judgment,
    judgmentStyle: result?.style,
    label: `${target.name} · ${target.rank}${decision} · ${summary}${membership}${composition}`,
    detail: summary + membership + decision + composition,
    segments: records.map((entry) => {
      const contributor = target.contributors.find((candidate) => candidate.id === entry.id);
      return {
        id: entry.id,
        contributing: contributor !== undefined,
        selected: contributor !== undefined && entry.id === selectedId,
        separated: contributor !== undefined && contributor.offset > 0,
        style: {
          display: contributor === undefined ? "none" : undefined,
          left: `${((contributor?.offset ?? 0) / maximum) * 100}%`,
          width: `${((contributor?.abundance ?? 0) / maximum) * 100}%`,
        },
      };
    }),
  };
};

const subscribeReducedMotion = (onChange: () => void) => {
  const media = window.matchMedia("(prefers-reduced-motion: reduce)");
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
};
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const serverReducedMotion = () => true;

/** Plot percentage-point compositions; revision identifies publications, animatePanels enables native transitions. */
export const AbundanceChart = ({
  findings,
  revision,
  animatePanels = false,
}: {
  readonly findings: PanelFindings;
  readonly revision: symbol;
  readonly animatePanels?: boolean;
}) => {
  const selection = useAtomValue(recordSelectionAtom);
  const reduce = useSyncExternalStore(subscribeReducedMotion, reducedMotion, serverReducedMotion);
  const animate = animatePanels && !reduce;
  const selected = Option.flatMap(selection, ({ recordId }) =>
    Array.findFirst(findings.records, (entry) => entry.record.id === recordId),
  );
  const selectedId = Option.getOrUndefined(selected)?.record.id;
  const hasSelection = Option.isSome(selected);
  const [presentation, dispatch] = useReducer(
    reducePresentation,
    { findings, animate, revision },
    initialPresentation,
  );
  // Keep history in React's render transaction: an abandoned render must not
  // mutate continuity, and prop changes must not paint an effect-delayed frame.
  if (presentation.revision !== revision || presentation.animate !== animate) {
    dispatch({ findings, animate, revision });
  }

  const story = selectionStory(selected, findings);

  return (
    <figure aria-label="Count abundance for each target">
      <Tooltip.Provider delay={0}>
        <div
          className={styles.chart}
          data-animate={animate}
          role="group"
          aria-label={`Target abundances from zero to ${presentation.maximum} percent`}
        >
          <div className={styles.axis} aria-hidden="true">
            <span>
              Target
              {hasSelection && <span className={styles.scope}>Selected record result</span>}
            </span>
            <span>
              <span className={styles.axisLabel}>Sample share (%)</span>
              <span className={styles.ticks}>
                {ticks.map((tick) => (
                  <span key={tick} style={{ left: `${tick}%` }}>
                    {(tick * presentation.maximum) / 100}
                  </span>
                ))}
              </span>
            </span>
            <span />
          </div>
          {presentation.rows.map((row) => {
            const { index, phase } = row;
            const {
              target,
              active,
              contributes,
              judgment,
              judgmentStyle,
              label,
              detail,
              segments,
            } = describeRow(row, selectedId, presentation.maximum);
            return (
              <Tooltip.Root key={target.id}>
                <Tooltip.Trigger
                  render={<div role="img" />}
                  disabled={!active}
                  className={styles.row}
                  data-target-id={target.id}
                  data-active={active}
                  data-contributing={contributes}
                  data-phase={phase}
                  inert={!active}
                  aria-hidden={!active || undefined}
                  tabIndex={active ? 0 : -1}
                  aria-label={label}
                  style={{ transform: `translateY(calc(${index} * var(--target-row-height)))` }}
                  onTransitionEnd={(event) => {
                    if (settlesAppearance(event)) dispatch({ settledTargetId: target.id });
                  }}
                >
                  <div className={styles.appearance}>
                    <div className={styles.targetLabel}>
                      <span className={styles.targetName}>{target.name}</span>
                      <span className={styles.rank}>
                        {target.rank}
                        {hasSelection && (
                          <>
                            {" "}
                            · <span style={judgmentStyle}>{judgment}</span>
                          </>
                        )}
                      </span>
                    </div>
                    <div className={styles.plot} data-plot="">
                      {ticks.map((tick) => (
                        <span key={tick} className={styles.gridLine} style={{ left: `${tick}%` }} />
                      ))}
                      <div className={styles.bar}>
                        {segments.map((segment) => (
                          <span
                            key={segment.id}
                            className={styles.segment}
                            data-record-id={segment.id}
                            data-contributing={segment.contributing}
                            data-selected={segment.selected}
                            data-separated={segment.separated}
                            style={segment.style}
                          />
                        ))}
                      </div>
                    </div>
                    <span className={styles.value}>{formatPercent(target.abundance / 100)}</span>
                  </div>
                </Tooltip.Trigger>
                {active && (
                  <Tooltip.Portal>
                    <Tooltip.Positioner
                      className={styles.positioner}
                      side="top"
                      align="end"
                      sideOffset={-2}
                      collisionBoundary="clipping-ancestors"
                      collisionPadding={{ top: 8, right: 0, bottom: 8, left: 0 }}
                      collisionAvoidance={{ side: "shift", align: "shift" }}
                    >
                      <Tooltip.Popup role="tooltip" className={styles.tooltip}>
                        <strong>{target.name}</strong>
                        {detail}
                      </Tooltip.Popup>
                    </Tooltip.Positioner>
                  </Tooltip.Portal>
                )}
              </Tooltip.Root>
            );
          })}
        </div>
      </Tooltip.Provider>
      <figcaption className={styles.footer}>
        <div className={styles.legend}>
          <span>
            <i className={styles.swatch} />
            {hasSelection ? "Other matching records" : "Matching records"}
          </span>
          <span>
            <i className={styles.selectedSwatch} />
            Selected record
          </span>
        </div>
        <p className={styles.note}>
          Each segment is one record’s share of the sample; a record can appear in several target
          totals.
        </p>
        <div className={styles.selectionStory}>
          <p>{story}</p>
        </div>
      </figcaption>
    </figure>
  );
};
