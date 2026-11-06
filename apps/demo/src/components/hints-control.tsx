"use client";

import { Button } from "@base-ui/react/button";
import { Dialog } from "@base-ui/react/dialog";
import { Result, Schema } from "effect";
import { useId, useRef, useState } from "react";
import { TaxonomyHint } from "robo-taxonomist";
import styles from "./hints-control.module.css";

/** Edit a local note, submitting its validated snapshot only when explicitly applying it. */
export const HintsControl = ({
  hints,
  submitting,
  onApply,
}: {
  readonly hints: ReadonlyArray<TaxonomyHint>;
  readonly submitting: boolean;
  readonly onApply: (hints: ReadonlyArray<TaxonomyHint>, animate: boolean) => void;
}) => {
  const id = useId();
  const input = useRef<HTMLTextAreaElement>(null);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [invalid, setInvalid] = useState(false);
  const apply = (animate: boolean) => {
    if (submitting) return;
    const parsed = Schema.decodeResult(Schema.Array(TaxonomyHint))(note === "" ? [] : [note]);
    if (Result.isFailure(parsed)) {
      setInvalid(true);
      input.current?.focus();
      return;
    }
    onApply(parsed.success, animate);
    setOpen(false);
  };
  return (
    <section aria-labelledby={`${id}-heading`} className={styles.control}>
      <Dialog.Root
        open={open}
        onOpenChange={(nextOpen) => {
          if (nextOpen) {
            setNote(hints.join("\n\n"));
            setInvalid(false);
          }
          setOpen(nextOpen);
        }}
      >
        <div className={styles.heading}>
          <div>
            <h2 id={`${id}-heading`}>Taxonomic hints</h2>
            <p className={styles.status}>
              {hints.length === 0 ? "Not supplied" : "Supplied for classification"}
            </p>
          </div>
          <Dialog.Trigger className={styles.edit} aria-label="Edit taxonomic hints">
            Edit
          </Dialog.Trigger>
        </div>
        <Dialog.Portal>
          <Dialog.Backdrop className={styles.backdrop} />
          <Dialog.Popup className={styles.popup}>
            <Dialog.Title className={styles.title}>Taxonomic hints</Dialog.Title>
            <Dialog.Description className={styles.description}>
              Supply background context for all records and panels. Apply it to reclassify the
              selected panel.
            </Dialog.Description>
            <label className={styles.label} htmlFor={`${id}-note`}>
              Background context
            </label>
            <textarea
              ref={input}
              id={`${id}-note`}
              className={styles.note}
              rows={7}
              value={note}
              aria-invalid={invalid || undefined}
              aria-describedby={invalid ? `${id}-help ${id}-error` : `${id}-help`}
              placeholder="For example: Acetobacter aceti belongs to Acetobacteraceae."
              onChange={(event) => {
                setNote(event.target.value);
                setInvalid(false);
              }}
            />
            <p className={styles.help} id={`${id}-help`}>
              The whole note is sent as one hint. Clear it to classify without hints.
            </p>
            {invalid && (
              <p className={styles.error} id={`${id}-error`} role="alert">
                Enter some text, or clear the field to remove hints. Spaces alone are not a hint.
              </p>
            )}
            <p className={styles.caveat}>
              Only live models respond to hints; fixture answers stay fixed. Live requests may incur
              API charges.
            </p>
            <div className={styles.actions}>
              <Dialog.Close className={styles.cancel}>Cancel</Dialog.Close>
              <Button
                className={styles.apply}
                disabled={submitting}
                focusableWhenDisabled
                onClick={(event) => apply(event.detail > 0)}
              >
                Apply and reclassify
              </Button>
            </div>
            {submitting && <p className={styles.help}>Wait for the current request to finish.</p>}
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </section>
  );
};
