import type { Metadata } from "next";
import { ThemeProvider } from "next-themes";
import type { ReactNode } from "react";
import "./globals.css";

/** Demo page identity; kept out of search indexes until it is ready for publication. */
export const metadata: Metadata = {
  title: "robo-taxonomist demo",
  description: "Choose a panel to see which taxa match each record.",
  robots: { index: false, follow: false },
};

/** Bootstraps the persisted or system theme before hydration. */
const RootLayout = ({ children }: { readonly children: ReactNode }) => {
  return (
    // The provider's initializer sets data-theme before React hydrates.
    <html lang="en" suppressHydrationWarning>
      <body>
        <ThemeProvider attribute="data-theme" storageKey="taxonomy-theme" defaultTheme="system">
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
};

export default RootLayout;
