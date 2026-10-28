import type { Metadata } from "next";
import type { ReactNode } from "react";
import styles from "../components/demo.module.css";

export const metadata: Metadata = {
  title: "Robo-taxonomist · Panel explorer",
  description: "Choose a panel to see which taxa match each record.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="en">
      <body className={styles.body}>{children}</body>
    </html>
  );
}
