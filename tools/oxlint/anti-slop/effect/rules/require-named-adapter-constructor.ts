import { defineRule, type ESTree } from "@oxlint/plugins";
import {
  collectEffectModuleNames,
  moduleMemberName,
  unwrapExpression,
} from "../shared/effect-modules.ts";

const isNamed = (expression: ESTree.Expression) =>
  expression.type === "Identifier" ||
  (expression.type === "MemberExpression" &&
    !expression.computed &&
    expression.property.type === "Identifier");

export const requireNamedAdapterConstructorRule = defineRule({
  meta: {
    type: "problem",
    messages: {
      inline:
        "Name this Layer.effect constructor in the concrete adapter, then reference it here. Keep the service tag independent of any default adapter.",
    },
  },
  create(context) {
    const names = collectEffectModuleNames(context.sourceCode.ast);

    return {
      CallExpression(node) {
        const callee = unwrapExpression(node.callee);
        if (moduleMemberName(callee, names, "Layer") !== "effect") return;

        const constructor = node.arguments[1];
        if (constructor === undefined || constructor.type === "SpreadElement") return;

        const expression = unwrapExpression(constructor);
        const target =
          expression.type === "CallExpression" ? unwrapExpression(expression.callee) : expression;

        if (moduleMemberName(target, names, "Effect") !== null || !isNamed(target)) {
          context.report({ node: constructor, messageId: "inline" });
        }
      },
    };
  },
});
