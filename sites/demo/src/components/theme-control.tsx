"use client";

import { useTheme } from "next-themes";
import styles from "./theme-control.module.css";

// Consult the browser only on intent when the provider has no valid explicit resolution.
const themeAfterToggle = (resolvedTheme: string | undefined) =>
  resolvedTheme === "dark" ||
  (resolvedTheme !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches)
    ? "light"
    : "dark";

export const ThemeControl = () => {
  const { resolvedTheme, setTheme } = useTheme();
  return (
    <button
      type="button"
      className={styles.themeControl}
      onClick={() => setTheme(themeAfterToggle(resolvedTheme))}
    >
      {/* The existing icon selectors also select the accessible name before hydration. */}
      <span className={`${styles.themeMoon} ${styles.themeLabel}`}>Switch to dark mode</span>
      <span className={`${styles.themeSun} ${styles.themeLabel}`}>Switch to light mode</span>
      <svg
        className={styles.themeMoon}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
      >
        <title>Switch to dark mode</title>
        <path d="M20.9 13.3A9 9 0 0 1 10.7 3.1a9 9 0 1 0 10.2 10.2Z" />
      </svg>
      <svg
        className={styles.themeSun}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        aria-hidden="true"
        focusable="false"
      >
        <title>Switch to light mode</title>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
      </svg>
    </button>
  );
};
