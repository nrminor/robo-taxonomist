import { eslintCompatPlugin } from "@oxlint/plugins";
import { noManualTagComparisonRule } from "./effect/rules/no-manual-tag-comparison.ts";
import { noManualTaggedConstructionRule } from "./effect/rules/no-manual-tagged-construction.ts";
import { noManualTaggedTypeRule } from "./effect/rules/no-manual-tagged-type.ts";
import { noOrDieInServiceConstructionRule } from "./effect/rules/no-ordie-in-service-construction.ts";
import { noStaticEffectServiceForwardersRule } from "./effect/rules/no-static-effect-service-forwarders.ts";
import { noUnboundedRetryRule } from "./effect/rules/no-unbounded-retry.ts";
import { preferEffectMatchRule } from "./effect/rules/prefer-effect-match.ts";
import { requireCauseWhenNarrowingRule } from "./effect/rules/require-cause-when-narrowing.ts";
import { requireNamedAdapterConstructorRule } from "./effect/rules/require-named-adapter-constructor.ts";
import { streamLargeFilesRule } from "./effect/rules/stream-large-files.ts";
import { throwInEffectGenRule } from "./effect/rules/throw-in-effect-gen.ts";
import { maxTernaryDepthRule } from "./rules/max-ternary-depth.ts";
import { noArrayFilterMapRule } from "./rules/no-array-filter-map.ts";
import { noChainedTypeAssertionsRule } from "./rules/no-chained-type-assertions.ts";
import { noConditionalSpreadRule } from "./rules/no-conditional-spread.ts";
import { noKnownValueWideningRule } from "./rules/no-known-value-widening.ts";
import { noModuleMockingRule } from "./rules/no-module-mocking.ts";
import { noObjectParametersRule } from "./rules/no-object-parameters.ts";
import { noReduceAccumulatorCopyRule } from "./rules/no-reduce-accumulator-copy.ts";
import { noUnknownReturnsRule } from "./rules/no-unknown-returns.ts";
import { noUnknownTypeAliasesRule } from "./rules/no-unknown-type-aliases.ts";
import { noUnsafeDictionaryTypeRule } from "./rules/no-unsafe-dictionary-type.ts";
import { noWidenThenAssertRule } from "./rules/no-widen-then-assert.ts";
import { requireReadableSpacingRule } from "./rules/require-readable-spacing.ts";
import { requireSafetyCommentForTypeAssertionRule } from "./rules/require-safety-comment-for-type-assertion.ts";

export default eslintCompatPlugin({
  meta: { name: "anti-slop" },
  rules: {
    "max-ternary-depth": maxTernaryDepthRule,
    "no-array-filter-map": noArrayFilterMapRule,
    "no-chained-type-assertions": noChainedTypeAssertionsRule,
    "no-conditional-spread": noConditionalSpreadRule,
    "no-known-value-widening": noKnownValueWideningRule,
    "no-manual-tag-comparison": noManualTagComparisonRule,
    "no-manual-tagged-construction": noManualTaggedConstructionRule,
    "no-manual-tagged-type": noManualTaggedTypeRule,
    "no-module-mocking": noModuleMockingRule,
    "no-object-parameters": noObjectParametersRule,
    "no-ordie-in-service-construction": noOrDieInServiceConstructionRule,
    "no-reduce-accumulator-copy": noReduceAccumulatorCopyRule,
    "no-static-effect-service-forwarders": noStaticEffectServiceForwardersRule,
    "no-unbounded-retry": noUnboundedRetryRule,
    "no-unknown-returns": noUnknownReturnsRule,
    "no-unknown-type-aliases": noUnknownTypeAliasesRule,
    "no-unsafe-dictionary-type": noUnsafeDictionaryTypeRule,
    "no-widen-then-assert": noWidenThenAssertRule,
    "prefer-effect-match": preferEffectMatchRule,
    "require-cause-when-narrowing": requireCauseWhenNarrowingRule,
    "require-named-adapter-constructor": requireNamedAdapterConstructorRule,
    "require-readable-spacing": requireReadableSpacingRule,
    "require-safety-comment-for-type-assertion": requireSafetyCommentForTypeAssertionRule,
    "stream-large-files": streamLargeFilesRule,
    "throw-in-effect-gen": throwInEffectGenRule,
  },
});
