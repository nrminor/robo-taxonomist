import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { panels } from "../lib/catalog.ts";
import {
  Selection,
  selectedPanelId,
  selectionAtom,
  selectPanelAtom,
} from "../client/panel-atoms.ts";
import styles from "./panel-controls.module.css";

export function PanelControls() {
  const selection = useAtomValue(selectionAtom);
  const choose = useAtomSet(selectionAtom);
  const run = useAtomSet(selectPanelAtom);
  return (
    <fieldset className={styles.panelChoices}>
      <legend>Compare records with</legend>
      {panels.map((panel) => (
        <label key={panel.id} className={styles.panelChoice}>
          <input
            type="radio"
            name="target-set"
            aria-label={panel.name}
            aria-describedby={`panel-description-${panel.id}`}
            checked={selectedPanelId(selection) === panel.id}
            onChange={() => {
              choose(Selection.cases.Panel.make({ panelId: panel.id }));
              run(panel.id);
            }}
          />
          <span>
            {panel.name}
            <span id={`panel-description-${panel.id}`} className={styles.choiceDescription}>
              {panel.description}
            </span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}
