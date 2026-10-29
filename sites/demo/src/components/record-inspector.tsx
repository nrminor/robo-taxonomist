import { type Ref } from "react";
import { panels } from "../lib/catalog.ts";
import { MatchJudgment, type PanelResponse } from "../lib/contract.ts";
import { formatPercent } from "../lib/display.ts";
import styles from "./record-inspector.module.css";

const answerLabels = {
  sameTaxon: "Same taxon",
  withinTaxon: "Within target taxon",
  noMatch: "Not a match",
  undetermined: "Undetermined",
} as const;
const answerNames = ["sameTaxon", "withinTaxon", "noMatch", "undetermined"] as const;

export function RecordInspector({
  record,
  response,
  headingRef,
  onBack,
}: {
  readonly record: { readonly id: string; readonly name: string };
  readonly response: PanelResponse;
  readonly headingRef: Ref<HTMLHeadingElement>;
  readonly onBack: () => void;
}) {
  const panel = panels.find((entry) => entry.id === response.panelId);
  const matches = response.rows.find((row) => row.recordId === record.id)?.matches ?? [];
  return (
    <section className={styles.inspector} aria-labelledby="inspector-title">
      <h3 id="inspector-title" ref={headingRef} tabIndex={-1}>
        {record.name}
      </h3>
      <p className={styles.intro}>Results in {panel?.name}</p>
      {panel?.targets.map((target) => {
        const match = matches.find((entry) => entry.targetId === target.id);
        if (!match) return null;
        const status = MatchJudgment.match(match.judgment, {
          Matched: () => ({ label: "Matches", className: styles.matched }),
          NotMatched: () => ({ label: "No match", className: styles.unmatched }),
          Undetermined: () => ({ label: "Uncertain", className: styles.uncertain }),
        });
        return (
          <div key={target.id} className={styles.judgment} role="group" aria-label={target.name}>
            <div className={styles.header}>
              <strong>{target.name}</strong>
              <span className={status.className}>{status.label}</span>
            </div>
            <p>Match support: {formatPercent(match.support)}</p>
            <details>
              <summary>Answer probabilities</summary>
              <div className={styles.probabilities}>
                <p>Answer: {answerLabels[match.answer.label]}</p>
                {answerNames.map((name) => (
                  <p key={name}>
                    {answerLabels[name]}: {formatPercent(match.answer.probabilities[name])}
                  </p>
                ))}
                {match.answer.confidence !== undefined && (
                  <p>Answer confidence: {formatPercent(match.answer.confidence)}</p>
                )}
              </div>
            </details>
          </div>
        );
      })}
      <button type="button" className={styles.back} onClick={onBack}>
        Back to sample records ↑
      </button>
    </section>
  );
}
