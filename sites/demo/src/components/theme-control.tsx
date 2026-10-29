"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./theme-control.module.css";

export function ThemeControl() {
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const explicitTheme = useRef<"light" | "dark" | null>(null);

  useEffect(() => {
    const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
    try {
      const stored = localStorage.getItem("taxonomy-theme");
      if (stored === "light" || stored === "dark") explicitTheme.current = stored;
    } catch {
      // Storage can be blocked; the live system preference still works.
    }
    const applyTheme = () => {
      const next = explicitTheme.current ?? (systemTheme.matches ? "dark" : "light");
      document.documentElement.dataset.theme = next;
      setTheme(next);
    };
    applyTheme();
    const handleSystemChange = () => {
      if (explicitTheme.current === null) applyTheme();
    };
    systemTheme.addEventListener("change", handleSystemChange);
    return () => systemTheme.removeEventListener("change", handleSystemChange);
  }, []);

  function toggleTheme() {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    explicitTheme.current = next;
    document.documentElement.dataset.theme = next;
    setTheme(next);
    try {
      localStorage.setItem("taxonomy-theme", next);
    } catch {
      // Keep this session's explicit choice even when persistence is unavailable.
    }
  }

  const label = theme === "dark" ? "Switch to light mode" : "Switch to dark mode";
  return (
    <button
      type="button"
      className={styles.themeControl}
      aria-label={label}
      title={label}
      onClick={toggleTheme}
    >
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
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
      </svg>
    </button>
  );
}
