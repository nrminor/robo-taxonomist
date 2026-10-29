import { panels, records, type PanelId } from "./catalog.ts";
import { MatchJudgment, type PanelResponse } from "./contract.ts";

const percent = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 2 });
const sampleWeight = records.reduce((sum, record) => sum + record.abundance, 0);

export const formatPercent = (fraction: number): string => percent.format(fraction);
export const formatSampleShare = (weight: number): string => formatPercent(weight / sampleWeight);

export interface Display {
  readonly response: PanelResponse;
  readonly matchedRecords: number;
  readonly comparedWith: PanelId | undefined;
  readonly changedRecords: number | undefined;
}

const acceptedTargets = (response: PanelResponse) =>
  new Map(
    response.rows.map((row) => [
      row.recordId,
      new Set(
        row.matches
          .filter((match) => MatchJudgment.guards.Matched(match.judgment))
          .map((match) => match.targetId),
      ),
    ]),
  );

export function replaceDisplayed(previous: Display | undefined, response: PanelResponse): Display {
  if (previous?.response === response) return previous;
  const current = acceptedTargets(response);
  let changedRecords: number | undefined;
  if (previous !== undefined) {
    const before = acceptedTargets(previous.response);
    changedRecords = 0;
    for (const [recordId, targets] of current) {
      const earlier = before.get(recordId);
      if (
        earlier === undefined ||
        earlier.size !== targets.size ||
        ![...targets].every((id) => earlier.has(id))
      ) {
        changedRecords++;
      }
    }
  }
  return {
    response,
    matchedRecords: [...current.values()].filter((targets) => targets.size > 0).length,
    comparedWith: previous?.response.panelId,
    changedRecords,
  };
}

export interface TargetComposition {
  readonly id: string;
  readonly name: string;
  readonly rank: string;
  readonly abundance: number;
  readonly contributors: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly abundance: number;
    readonly offset: number;
  }>;
}

export function targetCompositions(response: PanelResponse): ReadonlyArray<TargetComposition> {
  const panel = panels.find((entry) => entry.id === response.panelId);
  const accepted = acceptedTargets(response);
  return (panel?.targets ?? []).map((target) => {
    let abundance = 0;
    const contributors = records
      .filter((record) => accepted.get(record.id)?.has(target.id))
      .map((record) => {
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
}
