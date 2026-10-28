import { RegistryProvider } from "@effect/atom-react";
import { Demo } from "../components/demo.tsx";
import { initialReply } from "../server/classify.ts";

export const dynamic = "force-dynamic";

export default function Page() {
  return (
    <RegistryProvider>
      <Demo initial={initialReply()} />
    </RegistryProvider>
  );
}
