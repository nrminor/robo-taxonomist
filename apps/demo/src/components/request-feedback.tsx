import { useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import styles from "./request-feedback.module.css";

/** Restores focus on removal only when the disappearing feedback still contains it. */
export const RequestFeedback = ({
  children,
  returnFocusRef,
}: {
  readonly children: ReactNode;
  readonly returnFocusRef: RefObject<HTMLElement | null>;
}) => {
  const card = useRef<HTMLElement>(null);
  useLayoutEffect(
    () => () => {
      if (card.current?.contains(document.activeElement)) {
        returnFocusRef.current?.focus({ preventScroll: true });
      }
    },
    [returnFocusRef],
  );
  return (
    <section ref={card} className={styles.feedback} aria-label="Panel update">
      {children}
    </section>
  );
};
