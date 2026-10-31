import { type Ref } from "react";
import { formatPercent, judgmentPresentation, type RecordFinding } from "../lib/display.ts";
import styles from "./record-inspector.module.css";

const answerLabels = {
  sameTaxon: "Same taxon",
  withinTaxon: "Within target taxon",
  noMatch: "Not a match",
  undetermined: "Undetermined",
} as const;
const answerNames = ["sameTaxon", "withinTaxon", "noMatch", "undetermined"] as const;

/** Show one record's per-target answers; headingRef and onBack support list navigation. */
export const RecordInspector = ({
  finding,
  panelName,
  headingRef,
  onBack,
}: {
  readonly finding: RecordFinding;
  readonly panelName: string;
  readonly headingRef: Ref<HTMLHeadingElement>;
  readonly onBack: () => void;
}) => {
  return (
    <section className={styles.inspector} aria-labelledby="inspector-title">
      <h3 id="inspector-title" ref={headingRef} tabIndex={-1}>
        {finding.record.name}
      </h3>
      <p className={styles.intro}>Results in {panelName}</p>
      {finding.matches.map((match) => {
        const { target } = match;
        const result = judgmentPresentation(match.judgment);
        return (
          <div key={target.id} className={styles.judgment} role="group" aria-label={target.name}>
            <div className={styles.header}>
              <strong>{target.name}</strong>
              <span style={result.style}>{result.label}</span>
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
};
