import type { ESTree, Visitor } from "@oxlint/plugins";

import {
  lexicalTypeParameterNames,
  recordInferBinder,
  type InferBinders,
} from "./lexical-type-parameters.ts";

type TypeScope = ESTree.Node;

type TypeBinding = {
  readonly alias: ESTree.TSTypeAliasDeclaration | null;
  readonly name: string;
  readonly scope: TypeScope;
};

type Substitution = {
  readonly substitutions: Substitutions;
  readonly type: ESTree.TSType;
};

type Substitutions = ReadonlyMap<string, Substitution>;

export type TypeAliasEnvironment = {
  readonly aliases: readonly ESTree.TSTypeAliasDeclaration[];
  readonly bindingsByName: ReadonlyMap<string, readonly TypeBinding[]>;
  readonly inferBinders: InferBinders;
};

export type ResolvedTypeMatcher = (
  type: ESTree.TSType,
  matches: (child: ESTree.TSType) => boolean,
) => boolean;

function enclosingTypeScope(node: ESTree.Node): TypeScope {
  let current: ESTree.Node | null = node.parent;

  while (current !== null) {
    if (
      current.type === "Program" ||
      current.type === "BlockStatement" ||
      current.type === "TSModuleBlock" ||
      current.type === "StaticBlock" ||
      current.type === "SwitchStatement"
    ) {
      return current;
    }

    current = current.parent;
  }

  return node;
}

function declaredTypeBinding(node: ESTree.Node): {
  readonly alias: ESTree.TSTypeAliasDeclaration | null;
  readonly name: string;
} | null {
  if (node.type === "TSTypeAliasDeclaration") {
    return { alias: node, name: node.id.name };
  }

  if (
    node.type === "TSInterfaceDeclaration" ||
    node.type === "TSEnumDeclaration" ||
    node.type === "ClassDeclaration" ||
    node.type === "ClassExpression"
  ) {
    return node.id === null ? null : { alias: null, name: node.id.name };
  }

  if (
    node.type === "ImportSpecifier" ||
    node.type === "ImportDefaultSpecifier" ||
    node.type === "ImportNamespaceSpecifier"
  ) {
    return { alias: null, name: node.local.name };
  }

  return null;
}

function createTypeAliasIndex() {
  const bindingsByName = new Map<string, TypeBinding[]>();
  const aliases: ESTree.TSTypeAliasDeclaration[] = [];
  const inferBinders = new Map<ESTree.TSConditionalType, Set<string>>();
  const environment: TypeAliasEnvironment = { aliases, bindingsByName, inferBinders };

  const record = (node: ESTree.Node) => {
    const declared = declaredTypeBinding(node);

    if (declared === null) return;
    const bindings = bindingsByName.get(declared.name) ?? [];
    bindings.push({ ...declared, scope: enclosingTypeScope(node) });
    bindingsByName.set(declared.name, bindings);

    if (declared.alias !== null) aliases.push(declared.alias);
  };

  return {
    environment,
    record,
    recordInfer: (node: ESTree.TSInferType) => recordInferBinder(node, inferBinders),
  };
}

const indexesByProgram = new WeakMap<ESTree.Program, ReturnType<typeof createTypeAliasIndex>>();

/** Index each program once with Oxlint's visitors, then run rule checks in encounter order. */
export function withTypeAliasAnalysis(
  prepare: (program: ESTree.Program, environment: TypeAliasEnvironment) => void,
  checks: Visitor,
): Visitor {
  let index: ReturnType<typeof createTypeAliasIndex> | undefined;
  let ownsIndex = false;
  const pending: { readonly node: ESTree.Node; readonly check: (node: ESTree.Node) => void }[] = [];
  const deferredChecks: Visitor = {};

  for (const [selector, check] of Object.entries<Visitor[string]>(checks)) {
    if (check === undefined) continue;

    deferredChecks[selector] = (node) => {
      pending.push({ node, check });
    };
  }

  const record = (node: ESTree.Node) => {
    if (ownsIndex) index?.record(node);
  };

  return {
    ...deferredChecks,
    Program(program) {
      const existing = indexesByProgram.get(program);
      index = existing ?? createTypeAliasIndex();
      ownsIndex = existing === undefined;

      if (ownsIndex) indexesByProgram.set(program, index);
    },
    TSTypeAliasDeclaration(node) {
      record(node);
      deferredChecks.TSTypeAliasDeclaration?.(node);
    },
    TSInterfaceDeclaration: record,
    TSEnumDeclaration: record,
    ClassDeclaration: record,
    ClassExpression: record,
    ImportSpecifier: record,
    ImportDefaultSpecifier: record,
    ImportNamespaceSpecifier: record,
    TSInferType(node) {
      if (ownsIndex) index?.recordInfer(node);
    },
    "Program:exit"(node) {
      if (node.type !== "Program" || index === undefined)
        throw new Error("Type alias analysis requires a program index");
      prepare(node, index.environment);

      for (const { node, check } of pending) check(node);
      pending.length = 0;
    },
  };
}

function ancestorDistance(ancestor: ESTree.Node, node: ESTree.Node): number | null {
  let current: ESTree.Node | null = node;
  let distance = 0;

  while (current !== null) {
    if (current === ancestor) return distance;
    current = current.parent;
    distance += 1;
  }

  return null;
}

function nearestTypeBindings(
  name: string,
  use: ESTree.Node,
  environment: TypeAliasEnvironment,
): readonly TypeBinding[] {
  const candidates = environment.bindingsByName.get(name) ?? [];
  let nearestDistance = Number.POSITIVE_INFINITY;
  let nearest: TypeBinding[] = [];

  for (const candidate of candidates) {
    const distance = ancestorDistance(candidate.scope, use);

    if (distance === null || distance > nearestDistance) continue;

    if (distance === nearestDistance) {
      nearest.push(candidate);
      continue;
    }

    nearestDistance = distance;
    nearest = [candidate];
  }

  return nearest;
}

/** Resolve the nearest visible alias with this name, respecting lexical shadowing. */
export function visibleTypeAlias(
  name: string,
  use: ESTree.Node,
  environment: TypeAliasEnvironment,
): ESTree.TSTypeAliasDeclaration | null {
  if (lexicalTypeParameterNames(use, environment.inferBinders).has(name)) return null;
  const bindings = nearestTypeBindings(name, use, environment);

  return bindings.length === 1 ? (bindings[0]?.alias ?? null) : null;
}

/** Return whether a local declaration shadows a built-in type at this use. */
export function hasVisibleTypeBinding(
  name: string,
  use: ESTree.Node,
  environment: TypeAliasEnvironment,
): boolean {
  return (
    lexicalTypeParameterNames(use, environment.inferBinders).has(name) ||
    nearestTypeBindings(name, use, environment).length > 0
  );
}

function typeReferenceName(type: ESTree.TSTypeReference): string | null {
  return type.typeName.type === "Identifier" ? type.typeName.name : null;
}

function aliasSubstitutions(
  alias: ESTree.TSTypeAliasDeclaration,
  reference: ESTree.TSTypeReference,
  base: Substitutions,
): Substitutions | null {
  const parameters = alias.typeParameters?.params ?? [];
  const arguments_ = reference.typeArguments?.params ?? [];
  const next = new Map(base);

  for (const [index, parameter] of parameters.entries()) {
    const explicitArgument = arguments_[index];
    const argument = explicitArgument ?? parameter.default;

    if (argument === null || argument === undefined) return null;
    const argumentSubstitutions = explicitArgument === undefined ? next : base;
    next.set(parameter.name.name, {
      type: argument,
      substitutions: new Map(argumentSubstitutions),
    });
  }

  return next;
}

/** Match a type after resolving visible aliases and substituting their type parameters. */
export function resolvedTypeMatches(
  type: ESTree.TSType,
  environment: TypeAliasEnvironment,
  matcher: ResolvedTypeMatcher,
): boolean {
  const evaluate = (
    current: ESTree.TSType,
    substitutions: Substitutions,
    resolvingAliases: ReadonlySet<ESTree.TSTypeAliasDeclaration>,
  ): boolean => {
    if (current.type === "TSTypeReference") {
      const name = typeReferenceName(current);

      if (name !== null) {
        const substitution = substitutions.get(name);

        if (substitution !== undefined && (current.typeArguments?.params.length ?? 0) === 0) {
          return evaluate(substitution.type, substitution.substitutions, resolvingAliases);
        }

        const alias = visibleTypeAlias(name, current, environment);

        if (alias !== null && !resolvingAliases.has(alias)) {
          const nextSubstitutions = aliasSubstitutions(alias, current, substitutions);

          if (nextSubstitutions !== null) {
            const nextResolving = new Set(resolvingAliases);
            nextResolving.add(alias);

            return evaluate(alias.typeAnnotation, nextSubstitutions, nextResolving);
          }
        }
      }
    }

    return matcher(current, (child) => evaluate(child, substitutions, resolvingAliases));
  };

  return evaluate(type, new Map(), new Set());
}
