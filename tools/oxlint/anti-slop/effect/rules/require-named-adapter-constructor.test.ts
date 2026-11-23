import { RuleTester } from "oxlint/plugins-dev";
import { requireNamedAdapterConstructorRule } from "./require-named-adapter-constructor.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });

const imports = `import * as Layer from "effect/Layer"; import * as Effect from "effect/Effect";`;

tester.run("anti-slop/require-named-adapter-constructor", requireNamedAdapterConstructorRule, {
  valid: [
    `class Lookup extends Context.Service<Lookup, LookupOperations>()("Lookup") {}`,
    `${imports}
      const open = Effect.gen(function* () { return yield* acquire(); });
      export const layer = Layer.effect(Lookup, open);`,
    `${imports}
      export const layerAt = (path: string) => Layer.effect(Lookup, open(path));`,
    `const layer = OtherLayer.effect(Lookup, build());`,
  ],
  invalid: [
    {
      code: `${imports}
        export const layer = Layer.effect(Lookup, Effect.gen(function* () {
          return yield* acquire();
        }));`,
      errors: [{ messageId: "inline" }],
    },
    {
      code: `import { Effect, Layer as Layers } from "effect";
        const layer = Layers.effect(Lookup, Effect.succeed({ find }));`,
      errors: [{ messageId: "inline" }],
    },
  ],
});
