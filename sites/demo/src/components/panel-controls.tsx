import type { Ref } from "react";
import { panels, type PanelId } from "../lib/catalog.ts";
import styles from "./panel-controls.module.css";

/** Controlled panel choices; exposes the selected input as a focus-return destination. */
export const PanelControls = ({
  selected,
  onSelect,
  selectedInputRef,
}: {
  readonly selected: PanelId;
  readonly onSelect: (panelId: PanelId, animate: boolean) => void;
  readonly selectedInputRef: Ref<HTMLInputElement>;
}) => (
  <fieldset className={styles.panelChoices}>
    <legend>Compare records with</legend>
    {panels.map((panel) => (
      <label key={panel.id} className={styles.panelChoice}>
        <input
          type="radio"
          name="target-set"
          aria-label={panel.name}
          aria-describedby={`panel-description-${panel.id}`}
          checked={selected === panel.id}
          ref={selected === panel.id ? selectedInputRef : undefined}
          onChange={(event) =>
            onSelect(
              panel.id,
              event.nativeEvent instanceof MouseEvent && event.nativeEvent.detail > 0,
            )
          }
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
