import { RegistryProvider } from "@effect/atom-react";
import { connection } from "next/server";
import { Demo } from "../components/demo.tsx";
import { initialReply } from "../server/classify.ts";

const Page = async () => {
  await connection();

  return (
    <RegistryProvider>
      <Demo initial={initialReply()} />
    </RegistryProvider>
  );
};

export default Page;
