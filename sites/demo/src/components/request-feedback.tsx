import { useLayoutEffect, useRef, type ReactNode } from "react";
import styles from "./request-feedback.module.css";

export function RequestFeedback({ children }: { readonly children: ReactNode }) {
  const card = useRef<HTMLElement>(null);
  useLayoutEffect(
    () => () => {
      if (card.current?.contains(document.activeElement)) {
        document
          .querySelector<HTMLInputElement>('input[name="target-set"]:checked')
          ?.focus({ preventScroll: true });
      }
    },
    [],
  );
  return (
    <section ref={card} className={styles.feedback} aria-label="Panel update">
      {children}
    </section>
  );
}
