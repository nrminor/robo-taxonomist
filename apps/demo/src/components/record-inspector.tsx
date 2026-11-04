import { type Ref } from "react";
import { Match } from "effect";
import * as Display from "../lib/display.ts";
import styles from "./record-inspector.module.css";

/** Show one record's per-target answers; headingRef and onBack support list navigation. */
export const RecordInspector = ({
  finding,
  panelName,
  headingRef,
  onBack,
}: {
  readonly finding: Display.RecordFinding;
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
        const { target, answer } = match;
        const result = Display.judgmentPresentation(match.judgment);
        const answerLabel = Match.value(answer.label).pipe(
          Match.literalsExhaustive({
            sameTaxon: () => "Same taxon",
            withinTaxon: () => "Within target taxon",
            noMatch: () => "Not a match",
            undetermined: () => "Undetermined",
          }),
        );
        const p = answer.probabilities;
        return (
          <div key={target.id} className={styles.judgment} role="group" aria-label={target.name}>
            <div className={styles.header}>
              <strong>{target.name}</strong>
              <span style={result.style}>{result.label}</span>
            </div>
            {result.support !== undefined && (
              <p>Accepted answer support: {Display.formatPercent(result.support)}</p>
            )}
            <details>
              <summary>Answer probabilities</summary>
              <div className={styles.probabilities}>
                <p>Answer: {answerLabel}</p>
                <p>Same taxon: {Display.formatPercent(p.sameTaxon)}</p>
                <p>Within target taxon: {Display.formatPercent(p.withinTaxon)}</p>
                <p>Not a match: {Display.formatPercent(p.noMatch)}</p>
                <p>Undetermined: {Display.formatPercent(p.undetermined)}</p>
                {answer.confidence !== undefined && (
                  <p>Answer confidence: {Display.formatPercent(answer.confidence)}</p>
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
