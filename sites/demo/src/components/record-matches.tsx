import { useLayoutEffect, useRef } from "react";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Option } from "effect";
import { recordSelectionAtom } from "../client/panel-atoms.ts";
import { records } from "../lib/catalog.ts";
import { MatchJudgment, type PanelResponse } from "../lib/contract.ts";
import { formatSampleShare } from "../lib/display.ts";
import { RecordInspector } from "./record-inspector.tsx";
import styles from "./record-matches.module.css";

export function RecordMatches({ response }: { readonly response: PanelResponse }) {
  const selection = useAtomValue(recordSelectionAtom);
  const setSelection = useAtomSet(recordSelectionAtom);
  const selectedId = Option.isSome(selection) ? selection.value.recordId : undefined;
  const selected = records.find((record) => record.id === selectedId);
  const scroller = useRef<HTMLDivElement>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const heading = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => {
    if (Option.isNone(selection) || selection.value.origin !== "example") return;
    const container = scroller.current;
    const button = buttons.current.get(selection.value.recordId);
    if (!container || !button) return;
    const bounds = container.getBoundingClientRect();
    const rect = button.getBoundingClientRect();
    if (rect.top < bounds.top) container.scrollTop -= bounds.top - rect.top;
    else if (rect.bottom > bounds.bottom) container.scrollTop += rect.bottom - bounds.bottom;
  }, [selection]);

  const clear = () => {
    const button = selectedId === undefined ? undefined : buttons.current.get(selectedId);
    button?.focus({ preventScroll: true });
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
          {records.map((record) => {
            const row = response.rows.find((entry) => entry.recordId === record.id);
            const matched = row?.matches.some((match) =>
              MatchJudgment.guards.Matched(match.judgment),
            );
            const uncertain = row?.matches.some((match) =>
              MatchJudgment.guards.Undetermined(match.judgment),
            );
            const result = matched ? "Matches" : uncertain ? "Uncertain" : "No match";
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
                  ref={(button) => {
                    if (button) buttons.current.set(record.id, button);
                    else buttons.current.delete(record.id);
                  }}
                  aria-label={`${record.name}, ${share} of sample. ${result}. ${active ? "Clear selection" : "Select record"}`}
                  onClick={() =>
                    active
                      ? clear()
                      : setSelection(Option.some({ recordId: record.id, origin: "record" }))
                  }
                >
                  <span className={styles.recordName}>
                    {record.name}
                    <span className={styles.recordKind}>
                      {record.kind === "vague"
                        ? "Unresolved name"
                        : record.kind === "genus"
                          ? "Genus-only record"
                          : "Species record"}
                    </span>
                  </span>
                  <span className={styles.abundance}>{share}</span>
                  <span
                    className={`${styles.badge} ${matched ? styles.matched : uncertain ? styles.uncertain : styles.unmatched}`}
                  >
                    {result}
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
            key={selected.id}
            record={selected}
            response={response}
            headingRef={heading}
            onBack={() => {
              const button = buttons.current.get(selected.id);
              button?.scrollIntoView({ block: "center", behavior: "instant" });
              button?.focus({ preventScroll: true });
            }}
          />
        )}
      </div>
    </section>
  );
}
