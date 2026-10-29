import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "robo-taxonomist demo",
  description: "Choose a panel to see which taxa match each record.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    // The head initializer intentionally adds data-theme before React hydrates.
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `(() => {
  let theme;
  try { theme = localStorage.getItem('taxonomy-theme'); } catch {}
  document.documentElement.dataset.theme = theme === 'dark' || theme === 'light' ? theme : matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
})();`,
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
