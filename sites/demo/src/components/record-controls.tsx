import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Option } from "effect";
import { recordSelectionAtom } from "../client/panel-atoms.ts";
import { records } from "../lib/catalog.ts";
import { formatSampleShare } from "../lib/display.ts";
import styles from "./record-controls.module.css";

const examples = [
  { recordId: "r01", action: "Inspect species example" },
  { recordId: "r19", action: "Inspect genus-only example" },
  { recordId: "r23", action: "Inspect unclassified example" },
] satisfies ReadonlyArray<{ recordId: string; action: string }>;

const kinds = { species: "Species", genus: "Genus", vague: "Unclassified" };

export function RecordControls() {
  const selection = useAtomValue(recordSelectionAtom);
  const choose = useAtomSet(recordSelectionAtom);
  const recordId = Option.getOrUndefined(selection)?.recordId;
  const record = records.find((entry) => entry.id === recordId);
  return (
    <>
      <section aria-labelledby="current-record-label">
        <h2 className={styles.label} id="current-record-label">
          Current record
        </h2>
        <div aria-live="polite" aria-atomic="true">
          {record === undefined ? (
            <p className={styles.empty}>Select a record from the list or an example.</p>
          ) : (
            <>
              <p className={styles.name}>{record.name}</p>
              <p className={styles.metadata}>
                {kinds[record.kind]} · {formatSampleShare(record.abundance)}
              </p>
            </>
          )}
        </div>
      </section>
      <section aria-labelledby="record-examples-label">
        <h2 className={styles.label} id="record-examples-label">
          Inspect an example
        </h2>
        <div className={styles.examples}>
          {examples.map(({ recordId, action }) => (
            <button
              key={recordId}
              type="button"
              className={styles.example}
              onClick={() => choose(Option.some({ recordId, origin: "example" }))}
            >
              {action}
            </button>
          ))}
        </div>
      </section>
    </>
  );
}
