import { RegistryProvider } from "@effect/atom-react";
import { Demo } from "../components/demo.tsx";

/** Static shell with a page-scoped atom registry; classification starts in the browser. */
const Page = () => (
  <RegistryProvider>
    <Demo />
  </RegistryProvider>
);

export default Page;
