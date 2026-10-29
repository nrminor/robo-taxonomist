import { Tooltip } from "@base-ui/react/tooltip";
import { useAtomValue } from "@effect/atom-react";
import { Option } from "effect";
import { useState } from "react";
import { recordSelectionAtom } from "../client/panel-atoms.ts";
import { panels, records } from "../lib/catalog.ts";
import { MatchJudgment, type PanelResponse } from "../lib/contract.ts";
import {
  formatPercent,
  formatSampleShare,
  targetCompositions,
  type TargetComposition,
} from "../lib/display.ts";
import styles from "./abundance-chart.module.css";

interface PresentedRow {
  readonly composition: TargetComposition;
  readonly index: number;
  readonly active: boolean;
}

interface Presentation {
  readonly response: PanelResponse;
  readonly maximum: number;
  readonly rows: ReadonlyArray<PresentedRow>;
}

const targets = [
  ...new Map(
    panels.flatMap((panel) => panel.targets).map((target) => [target.id, target]),
  ).values(),
];
const ticks = [0, 25, 50, 75, 100];

function present(response: PanelResponse, previous?: Presentation): Presentation {
  const compositions = targetCompositions(response);
  const active = new Set(compositions.map((target) => target.id));
  const history =
    previous?.rows ??
    targets.map((target) => ({
      composition: { ...target, abundance: 0, contributors: [] },
      index: 0,
      active: false,
    }));
  return {
    response,
    maximum: Math.max(
      previous?.maximum ?? 40,
      ...compositions.map((target) => Math.ceil(target.abundance / 20) * 20),
    ),
    rows: [
      ...compositions.map((composition, index) => ({ composition, index, active: true })),
      ...history
        .filter((row) => !active.has(row.composition.id))
        .map((row) => ({ ...row, active: false })),
    ],
  };
}

export function AbundanceChart({
  response,
  boundary,
}: {
  readonly response: PanelResponse;
  readonly boundary?: HTMLElement | null;
}) {
  const selection = useAtomValue(recordSelectionAtom);
  const selectedId = Option.getOrUndefined(selection)?.recordId;
  const record = records.find((entry) => entry.id === selectedId);
  const selectedMatches = response.rows.find((row) => row.recordId === selectedId)?.matches ?? [];
  const matched = selectedMatches.filter((match) =>
    MatchJudgment.guards.Matched(match.judgment),
  ).length;
  const uncertain = selectedMatches.filter((match) =>
    MatchJudgment.guards.Undetermined(match.judgment),
  ).length;
  const panel = panels.find((entry) => entry.id === response.panelId);
  const [presentation, setPresentation] = useState(() => present(response));
  if (presentation.response !== response) setPresentation(present(response, presentation));

  const story =
    record === undefined
      ? "Select a record to locate its segment in matching targets."
      : matched > 0
        ? `This record is ${formatSampleShare(record.abundance)} of the sample and matches ${matched} target${matched === 1 ? "" : "s"}. The same record is included in each matching total.`
        : uncertain > 0
          ? `There is not enough information to decide whether this record matches ${uncertain} target${uncertain === 1 ? "" : "s"}. It is not included in any target total in ${panel?.name}.`
          : `This record does not match any target in ${panel?.name}, so it is not included in any target total.`;

  return (
    <figure aria-label="Count abundance for each target">
      <Tooltip.Provider delay={0}>
        <div
          className={styles.chart}
          role="group"
          aria-label={`Target abundances from zero to ${presentation.maximum} percent`}
        >
          <div className={styles.axis} aria-hidden="true">
            <span>
              Target
              {record !== undefined && <span className={styles.scope}>Selected record result</span>}
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
          {presentation.rows.map(({ composition: target, index, active }) => {
            const match = selectedMatches.find((entry) => entry.targetId === target.id);
            const contributes = target.contributors.some((entry) => entry.id === selectedId);
            const judgment =
              match === undefined
                ? "Unavailable"
                : MatchJudgment.guards.Matched(match.judgment)
                  ? "Matches"
                  : MatchJudgment.guards.Undetermined(match.judgment)
                    ? "Uncertain"
                    : "No match";
            const summary = `${formatPercent(target.abundance / 100)} of sample · ${target.contributors.length} matching record${target.contributors.length === 1 ? "" : "s"}`;
            const membership =
              record === undefined
                ? ""
                : contributes
                  ? " · selected record is included"
                  : " · selected record is not included";
            const decision =
              record === undefined
                ? ""
                : ` · ${judgment} · Match support: ${match === undefined ? "Unavailable" : formatPercent(match.support)}`;
            const composition =
              target.contributors.length === 0
                ? ""
                : ` · Records: ${target.contributors.map((entry) => `${entry.name} ${formatPercent(entry.abundance / 100)}`).join("; ")}`;
            const detail = summary + membership + decision + composition;
            return (
              <Tooltip.Root key={target.id}>
                <Tooltip.Trigger
                  render={<div role="img" />}
                  disabled={!active}
                  className={styles.row}
                  data-target-id={target.id}
                  data-active={active}
                  data-contributing={contributes}
                  hidden={!active}
                  inert={!active}
                  aria-hidden={!active || undefined}
                  tabIndex={active ? 0 : -1}
                  aria-label={`${target.name} · ${target.rank}${decision} · ${summary}${membership}${composition}`}
                  style={{ transform: `translateY(calc(${index} * var(--target-row-height)))` }}
                >
                  <div className={styles.targetLabel}>
                    <span className={styles.targetName}>{target.name}</span>
                    <span className={styles.rank}>
                      {target.rank}
                      {record !== undefined && (
                        <>
                          {" "}
                          · <span data-judgment={judgment}>{judgment}</span>
                        </>
                      )}
                    </span>
                  </div>
                  <div className={styles.plot} data-plot="">
                    {ticks.map((tick) => (
                      <span key={tick} className={styles.gridLine} style={{ left: `${tick}%` }} />
                    ))}
                    <div className={styles.bar}>
                      {records.map((entry) => {
                        const contributor = target.contributors.find(
                          (candidate) => candidate.id === entry.id,
                        );
                        return (
                          <span
                            key={entry.id}
                            className={styles.segment}
                            data-record-id={entry.id}
                            data-contributing={contributor !== undefined}
                            data-selected={contributor !== undefined && entry.id === selectedId}
                            data-separated={contributor !== undefined && contributor.offset > 0}
                            style={{
                              display: contributor === undefined ? "none" : undefined,
                              left: `${((contributor?.offset ?? 0) / presentation.maximum) * 100}%`,
                              width: `${((contributor?.abundance ?? 0) / presentation.maximum) * 100}%`,
                            }}
                          />
                        );
                      })}
                    </div>
                  </div>
                  <span className={styles.value}>{formatPercent(target.abundance / 100)}</span>
                </Tooltip.Trigger>
                {active && (
                  <Tooltip.Portal container={boundary ?? undefined}>
                    <Tooltip.Positioner
                      className={styles.positioner}
                      side="top"
                      align="end"
                      sideOffset={-2}
                      collisionBoundary={boundary ?? undefined}
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
            {record === undefined ? "Matching records" : "Other matching records"}
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
}
