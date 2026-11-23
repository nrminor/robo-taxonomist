import { CloudflareClient, CloudflareDecisionModel } from "@effect/ai-cloudflare";
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai";
import { Config, Layer } from "effect";
import type { TraitsConfig } from "traits";

const cloudflare = CloudflareClient.layerConfig();

const openAi = OpenAiClient.layerConfig({ apiKey: Config.Redacted("OPENAI_API_KEY") });

const clef = CloudflareDecisionModel.layer({ model: "clef" });

const traitGeneration = OpenAiLanguageModel.layer({
  model: "gpt-6.1-sol",
  config: { strictJsonSchema: true },
});

export default {
  layerDecisionModel: clef.pipe(Layer.provide(cloudflare)),
  layerLanguageModel: traitGeneration.pipe(Layer.provide(openAi)),
} satisfies TraitsConfig;
