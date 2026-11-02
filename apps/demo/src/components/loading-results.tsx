import type { ReactNode } from "react";
import { records, type panels } from "../lib/catalog.ts";
import { formatSampleShare, recordKindLabel } from "../lib/display.ts";
import layoutStyles from "./demo.module.css";
import recordStyles from "./record-matches.module.css";
import styles from "./loading-results.module.css";

/** Reserves the results layout before first success, showing only known catalog inputs and targets. */
export const LoadingResults = ({
  panel,
  feedback,
}: {
  readonly panel: (typeof panels)[number];
  readonly feedback?: ReactNode;
}) => (
  <section className={layoutStyles.workspace} aria-label="Loading panel results">
    <section className={recordStyles.recordsSection} aria-label="Loading input records">
      <div className={recordStyles.recordsHeading}>
        <h2 id="loading-records">Input records</h2>
      </div>
      <div className={recordStyles.columns} aria-hidden="true">
        <span>Record</span>
        <span>Sample share</span>
        <span>Panel result</span>
      </div>
      <div className={recordStyles.recordsScroll} aria-hidden="true">
        <ul className={recordStyles.recordList}>
          {records.map((record) => (
            <li key={record.id} className={recordStyles.recordItem}>
              <div className={styles.record}>
                <span className={recordStyles.recordName}>
                  {record.name}
                  <span className={recordStyles.recordKind}>{recordKindLabel(record.kind)}</span>
                </span>
                <span className={recordStyles.abundance}>
                  {formatSampleShare(record.abundance)}
                </span>
                <span className={styles.placeholder} />
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
    <section className={layoutStyles.chartSection} aria-label="Loading panel targets">
      <div className={layoutStyles.sectionTop}>
        <h2 id="loading-panel-targets">Panel targets</h2>
        <span className={layoutStyles.sectionMeta}>{panel.targets.length} targets</span>
      </div>
      <div className={layoutStyles.resultSummary}>
        <div className={layoutStyles.chartInspection}>
          {feedback ?? <p>Classifying with {panel.name}…</p>}
        </div>
      </div>
      <div className={styles.chart} aria-hidden="true">
        {panel.targets.map((target) => (
          <div key={target.id} className={styles.target}>
            <span className={styles.targetLabel}>
              {target.name}
              <span className={styles.rank}>{target.rank}</span>
            </span>
            <span className={styles.placeholder} />
          </div>
        ))}
      </div>
    </section>
  </section>
);
