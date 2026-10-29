import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { panels, type PanelId } from "../lib/catalog.ts";
import { animatePanelsAtom, selectedPanelId, selectionAtom } from "../client/panel-atoms.ts";
import styles from "./panel-controls.module.css";

export function PanelControls({ onSelect }: { readonly onSelect: (panelId: PanelId) => void }) {
  const selection = useAtomValue(selectionAtom);
  const animatePanels = useAtomSet(animatePanelsAtom);
  return (
    <>
      <fieldset
        className={styles.panelChoices}
        onPointerDown={() => animatePanels(true)}
        onKeyDown={() => animatePanels(false)}
      >
        <legend>Compare records with</legend>
        {panels.map((panel) => (
          <label key={panel.id} className={styles.panelChoice}>
            <input
              type="radio"
              name="target-set"
              aria-label={panel.name}
              aria-describedby={`panel-description-${panel.id}`}
              checked={selectedPanelId(selection) === panel.id}
              onChange={() => onSelect(panel.id)}
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
    </>
  );
}
