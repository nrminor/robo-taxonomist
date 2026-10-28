import { Fragment } from "react";
import { panels, records } from "../lib/catalog.ts";
import { MatchJudgment, type PanelResponse } from "../lib/contract.ts";
import styles from "./demo.module.css";

const percent = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 1 });
const answerLabels = {
  sameTaxon: "Same taxon",
  withinTaxon: "Within a broader taxon",
  noMatch: "Does not match",
  undetermined: "Cannot determine",
} satisfies Record<PanelResponse["rows"][number]["matches"][number]["answer"]["label"], string>;
const answerNames = ["sameTaxon", "withinTaxon", "noMatch", "undetermined"] as const;

export function RecordMatches({ response }: { readonly response: PanelResponse }) {
  const targets = panels.find((panel) => panel.id === response.panelId)?.targets ?? [];
  return (
    <section aria-labelledby="check-records" className={styles.records}>
      <h3 id="check-records">Check each record</h3>
      <p>Select a name to inspect each match and its support.</p>
      <ul className={styles.recordList}>
        {response.rows.map((row) => {
          const record = records.find((entry) => entry.id === row.recordId);
          if (record === undefined) return null;
          const accepted = row.matches.filter((match) =>
            MatchJudgment.guards.Matched(match.judgment),
          ).length;
          const unresolved = row.matches.some((match) =>
            MatchJudgment.guards.Undetermined(match.judgment),
          );
          const outcome =
            accepted > 0
              ? `Matches ${accepted} ${accepted === 1 ? "target" : "targets"}`
              : unresolved
                ? "Cannot determine a match"
                : "Does not match a target";
          return (
            <li key={row.recordId}>
              <details>
                <summary aria-label={`Inspect ${record.name}`} className={styles.recordSummary}>
                  <span className={styles.recordName}>
                    {record.kind === "vague" ? record.name : <em>{record.name}</em>}
                  </span>
                  <span className={styles.abundance}>{percent.format(record.abundance / 100)}</span>
                  <span className={styles.outcome}>{outcome}</span>
                  <svg
                    className={styles.chevron}
                    viewBox="0 0 16 16"
                    width="16"
                    height="16"
                    aria-hidden="true"
                  >
                    <path d="m6 4 4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.5" />
                  </svg>
                </summary>
                <div className={styles.comparisons}>
                  <table aria-label={`Classify ${record.name}`}>
                    <thead>
                      <tr>
                        <th scope="col">Target</th>
                        <th scope="col">Match</th>
                        <th scope="col">Support</th>
                        <th scope="col">Answer</th>
                      </tr>
                    </thead>
                    <tbody>
                      {row.matches.map((match) => (
                        <tr key={match.targetId}>
                          <th scope="row">
                            {targets.find((target) => target.id === match.targetId)?.name}
                          </th>
                          <td>
                            {MatchJudgment.match(match.judgment, {
                              Matched: () => "Matches",
                              NotMatched: () => "Does not match",
                              Undetermined: () => "Cannot determine",
                            })}
                          </td>
                          <td>{percent.format(match.support)}</td>
                          <td>
                            <details>
                              <summary>{answerLabels[match.answer.label]}</summary>
                              <dl>
                                {answerNames.map((name) => (
                                  <Fragment key={name}>
                                    <dt>{answerLabels[name]}</dt>
                                    <dd>{percent.format(match.answer.probabilities[name])}</dd>
                                  </Fragment>
                                ))}
                                {match.answer.confidence !== undefined && (
                                  <>
                                    <dt>Provider confidence</dt>
                                    <dd>{percent.format(match.answer.confidence)}</dd>
                                  </>
                                )}
                              </dl>
                            </details>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
