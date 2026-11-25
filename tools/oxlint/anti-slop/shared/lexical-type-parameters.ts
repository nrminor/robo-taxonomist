import type { ESTree } from "@oxlint/plugins";

export type InferBinders = ReadonlyMap<ESTree.TSConditionalType, ReadonlySet<string>>;

/** Index an infer binder for each conditional type whose extends branch contains it. */
export function recordInferBinder(
  infer: ESTree.TSInferType,
  binders: Map<ESTree.TSConditionalType, Set<string>>,
): void {
  let child: ESTree.Node = infer;

  for (let parent: ESTree.Node | null = child.parent; parent !== null; parent = parent.parent) {
    if (parent.type === "TSConditionalType" && parent.extendsType === child) {
      const names = binders.get(parent) ?? new Set<string>();
      names.add(infer.typeParameter.name.name);
      binders.set(parent, names);
    }

    child = parent;
  }
}

/** Collect type binders that are in scope at a node and can shadow module aliases. */
export function lexicalTypeParameterNames(
  node: ESTree.Node,
  inferBinders: InferBinders,
): ReadonlySet<string> {
  const names = new Set<string>();
  let descendant: ESTree.Node = node;
  let current: ESTree.Node | null = node;

  while (current !== null && current.type !== "Program") {
    if ("typeParameters" in current) {
      for (const parameter of current.typeParameters?.params ?? []) {
        names.add(parameter.name.name);
      }
    }

    if (
      current.type === "TSMappedType" &&
      (descendant === current.nameType || descendant === current.typeAnnotation)
    ) {
      names.add(current.key.name);
    }

    if (current.type === "TSConditionalType" && descendant === current.trueType) {
      for (const name of inferBinders.get(current) ?? []) names.add(name);
    }

    descendant = current;
    current = current.parent;
  }

  return names;
}
