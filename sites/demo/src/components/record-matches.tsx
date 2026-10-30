import { useLayoutEffect, useRef } from "react";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Option } from "effect";
import { recordSelectionAtom } from "../client/panel-atoms.ts";
import {
  formatSampleShare,
  judgmentPresentation,
  recordKindLabel,
  type PanelFindings,
} from "../lib/display.ts";
import { RecordInspector } from "./record-inspector.tsx";
import styles from "./record-matches.module.css";

/** Browse published findings, preserving focus and local scroll when selecting or clearing. */
export const RecordMatches = ({ findings }: { readonly findings: PanelFindings }) => {
  const selection = useAtomValue(recordSelectionAtom);
  const setSelection = useAtomSet(recordSelectionAtom);
  const selectedId = Option.isSome(selection) ? selection.value.recordId : undefined;
  const selected = findings.records.find((finding) => finding.record.id === selectedId);
  const scroller = useRef<HTMLDivElement>(null);
  const selectedButton = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => {
    if (Option.isNone(selection) || selection.value.origin !== "example") return;
    const container = scroller.current;
    const button = selectedButton.current;
    if (!container || !button) return;
    const bounds = container.getBoundingClientRect();
    const rect = button.getBoundingClientRect();
    if (rect.top < bounds.top) container.scrollTop -= bounds.top - rect.top;
    else if (rect.bottom > bounds.bottom) container.scrollTop += rect.bottom - bounds.bottom;
  }, [selection]);

  const clear = () => {
    selectedButton.current?.focus({ preventScroll: true });
    setSelection(Option.none());
  };
  return (
    <section aria-labelledby="check-records" className={styles.recordsSection}>
      <div className={styles.recordsHeading}>
        <h2 id="check-records">Input records</h2>
      </div>
      <div className={styles.columns} aria-hidden="true">
        <span>Record</span>
        <span>Sample share</span>
        <span>Panel result</span>
      </div>
      <div
        ref={scroller}
        className={styles.recordsScroll}
        tabIndex={0}
        aria-label="Sample records and selected-record matches"
      >
        <ul className={styles.recordList}>
          {findings.records.map(({ record, judgment }) => {
            const result = judgmentPresentation(judgment);
            const active = record.id === selectedId;
            const share = formatSampleShare(record.abundance);
            return (
              <li
                key={record.id}
                className={`${styles.recordItem} ${active ? styles.selected : ""}`}
              >
                <button
                  type="button"
                  className={styles.record}
                  aria-pressed={active}
                  ref={active ? selectedButton : undefined}
                  aria-label={`${record.name}, ${share} of sample. ${result.label}. ${active ? "Clear selection" : "Select record"}`}
                  onClick={() =>
                    active
                      ? clear()
                      : setSelection(Option.some({ recordId: record.id, origin: "record" }))
                  }
                >
                  <span className={styles.recordName}>
                    {record.name}
                    <span className={styles.recordKind}>{recordKindLabel(record.kind)}</span>
                  </span>
                  <span className={styles.abundance}>{share}</span>
                  <span className={styles.badge} style={result.style}>
                    {result.label}
                  </span>
                </button>
                {active && (
                  <div className={styles.actions}>
                    <button
                      type="button"
                      onClick={() => {
                        heading.current?.scrollIntoView({ block: "start", behavior: "instant" });
                        heading.current?.focus({ preventScroll: true });
                      }}
                    >
                      View answer details
                    </button>
                    <button type="button" onClick={clear}>
                      Clear selection
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        {selected && (
          <RecordInspector
            key={selected.record.id}
            finding={selected}
            panelName={findings.panel.name}
            headingRef={heading}
            onBack={() => {
              const button = selectedButton.current;
              button?.scrollIntoView({ block: "center", behavior: "instant" });
              button?.focus({ preventScroll: true });
            }}
          />
        )}
      </div>
    </section>
  );
};
