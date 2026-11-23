import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Errors from "../errors.ts";
import { TaxonId, TaxonName, TaxonSource } from "../schemas.ts";

const decimalId = Schema.String.check(Schema.isPattern(/^[1-9][0-9]*$/u));

const rootId = "1";

/**
 * Construct an NCBI identifier with a decimal ID and an optional release.
 * `make` and `makeEffect` supply the taxonomy; decoding requires it in the input.
 *
 * @category schemas
 * @since 0.7.0
 * @example
 * import { NcbiTaxonId } from "robo-taxonomist";
 *
 * export const oakId = NcbiTaxonId.make({ id: "58334" });
 */
export const NcbiTaxonId = Schema.Struct({
  taxonomy: Schema.tag("ncbi"),
  id: decimalId,
  release: TaxonId.fields.release,
}).pipe(Schema.brand("NcbiTaxonId"));

/** An NCBI identifier usable wherever the library accepts a TaxonId. */
export type NcbiTaxonId = typeof NcbiTaxonId.Type;

const dumpOptions = Schema.Struct({
  directory: TaxonId.fields.taxonomy,
  release: TaxonId.fields.release,
});

type DumpOptions = typeof dumpOptions.Type;

type Node = {
  readonly parent: string;
  readonly rank: string;
  scientificName?: TaxonName;
  parentCheck?: "visiting" | "verified";
};

type RecordedName = {
  readonly id: string;
  readonly nameClass: string;
};

const rowFraming = Schema.String.check(Schema.isPattern(/\t\|$/u));

const checkFraming = Schema.decodeUnknownResult(rowFraming);

const decodeNode = Schema.decodeUnknownResult(
  Schema.Tuple([decimalId, decimalId, TaxonId.fields.taxonomy]),
);

const decodeName = Schema.decodeUnknownResult(
  Schema.Tuple([decimalId, TaxonName, Schema.String, TaxonId.fields.taxonomy]),
);

const decodeMerge = Schema.decodeUnknownResult(Schema.Tuple([decimalId, decimalId]));

const decodeDeletion = Schema.decodeUnknownResult(Schema.Tuple([decimalId]));

const readRows = <A, E>(
  fs: FileSystem.FileSystem,
  path: string,
  decode: (fields: readonly string[]) => Result.Result<A, Schema.SchemaError>,
  add: (row: A, line: number) => E | undefined,
  columnLimit?: number,
) => {
  let line = 0;

  const rows = fs.stream(path).pipe(
    Stream.mapError((cause) => new Errors.TaxonSnapshotReadError({ path, cause })),
    Stream.decodeText,
    Stream.splitLines,
  );

  return Stream.runForEachArray(
    rows,
    Effect.fnUntraced(function* (batch) {
      for (const text of batch) {
        line++;
        const framing = checkFraming(text);

        if (Result.isFailure(framing)) {
          return yield* new Errors.InvalidTaxonSnapshot({ path, line, cause: framing.failure });
        }

        const fields = text.slice(0, -2).split("\t|\t", columnLimit);
        const row = decode(fields);

        if (Result.isFailure(row)) {
          return yield* new Errors.InvalidTaxonSnapshot({ path, line, cause: row.failure });
        }

        const issue = add(row.success, line);

        if (issue !== undefined) return yield* Effect.fail(issue);
      }
    }),
  );
};

const checkParents = (nodes: ReadonlyMap<string, Node>) => {
  const root = nodes.get(rootId);
  const issues = Errors.NcbiDumpIssue.cases;

  if (root === undefined) return issues.InvalidRoot.make({});

  if (root.parent !== rootId) return issues.InvalidRoot.make({ parentId: root.parent });

  root.parentCheck = "verified";

  for (const [id, node] of nodes) {
    let currentId = id;
    let current = node;

    // A verified path already terminates at the root. Only the active path is visiting.
    while (current.parentCheck !== "verified") {
      if (current.parentCheck === "visiting") return issues.ParentCycle.make({ id: currentId });

      const parentId = current.parent;
      const parent = nodes.get(parentId);

      if (parent === undefined) return issues.MissingTaxonParent.make({ id: currentId, parentId });

      current.parentCheck = "visiting";
      currentId = parentId;
      current = parent;
    }

    let ancestor: Node | undefined = node;

    while (ancestor?.parentCheck === "visiting") {
      ancestor.parentCheck = "verified";
      ancestor = nodes.get(ancestor.parent);
    }
  }

  return undefined;
};

const openDump = Effect.fnUntraced(function* (options: DumpOptions) {
  const configured = yield* Schema.decodeEffect(dumpOptions)(options).pipe(
    Effect.mapError(Errors.InvalidInput.from),
  );

  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { directory, ...release } = configured;
  const source = TaxonSource.cases.Snapshot.make({ taxonomy: "ncbi", ...release });
  const nodes = new Map<string, Node>();
  const merges = new Map<string, string>();
  const deletions = new Set<string>();
  const names = new Map<TaxonName, RecordedName[]>();

  const nodesPath = path.join(directory, "nodes.dmp");
  yield* readRows(
    fs,
    nodesPath,
    decodeNode,
    ([id, parent, rank], line) => {
      if (nodes.has(id)) {
        const reason = Errors.NcbiDumpIssue.cases.DuplicateTaxonNode.make({
          id,
          path: nodesPath,
          line,
        });

        return new Errors.InconsistentNcbiDump({ ...configured, reason });
      }

      nodes.set(id, { parent, rank });
    },
    3,
  );

  const namesPath = path.join(directory, "names.dmp");
  yield* readRows(fs, namesPath, decodeName, ([id, name, , nameClass], line) => {
    const node = nodes.get(id);

    if (node === undefined) {
      const reason = Errors.NcbiDumpIssue.cases.NameWithoutTaxon.make({
        id,
        path: namesPath,
        line,
      });

      return new Errors.InconsistentNcbiDump({ ...configured, reason });
    }

    if (nameClass === "scientific name") {
      if (node.scientificName !== undefined) {
        const reason = Errors.NcbiDumpIssue.cases.ScientificNameCount.make({
          id,
          count: 2,
          path: namesPath,
          line,
        });

        return new Errors.InconsistentNcbiDump({ ...configured, reason });
      }

      node.scientificName = name;
    }

    if (
      nameClass !== "scientific name" &&
      nameClass !== "synonym" &&
      nameClass !== "genbank synonym"
    ) {
      return;
    }

    const match = { id, nameClass };
    const existing = names.get(name);

    if (existing === undefined) names.set(name, [match]);
    else existing.push(match);
  });

  const mergesPath = path.join(directory, "merged.dmp");
  yield* readRows(fs, mergesPath, decodeMerge, ([id, target], line) => {
    const first = merges.get(id);

    if (first !== undefined && first !== target) {
      const reason = Errors.NcbiDumpIssue.cases.ConflictingMergeTargets.make({
        id,
        first,
        second: target,
        path: mergesPath,
        line,
      });

      return new Errors.InconsistentNcbiDump({ ...configured, reason });
    }

    merges.set(id, target);
  });
  yield* readRows(fs, path.join(directory, "delnodes.dmp"), decodeDeletion, ([id]) => {
    deletions.add(id);
  });

  const parentIssue = checkParents(nodes);

  if (parentIssue !== undefined) {
    return yield* new Errors.InconsistentNcbiDump({ ...configured, reason: parentIssue });
  }

  for (const [id, targetId] of merges) {
    if (nodes.has(id)) {
      const reason = Errors.NcbiDumpIssue.cases.ConflictingTaxonStatus.make({
        id,
        existing: "current",
        incoming: "merged",
      });

      return yield* new Errors.InconsistentNcbiDump({ ...configured, reason });
    }

    if (!nodes.has(targetId)) {
      const reason = Errors.NcbiDumpIssue.cases.MissingMergeTarget.make({ id, targetId });

      return yield* new Errors.InconsistentNcbiDump({ ...configured, reason });
    }
  }

  for (const id of deletions) {
    const existing = nodes.has(id) ? "current" : merges.has(id) ? "merged" : undefined;

    if (existing !== undefined) {
      const reason = Errors.NcbiDumpIssue.cases.ConflictingTaxonStatus.make({
        id,
        existing,
        incoming: "deleted",
      });

      return yield* new Errors.InconsistentNcbiDump({ ...configured, reason });
    }
  }

  for (const [id, node] of nodes) {
    if (node.scientificName === undefined) {
      const reason = Errors.NcbiDumpIssue.cases.ScientificNameCount.make({
        id,
        count: 0,
        path: namesPath,
      });

      return yield* new Errors.InconsistentNcbiDump({ ...configured, reason });
    }
  }

  return {
    source,
    node: (id: string) => nodes.get(id),
    replacement: (id: string) => merges.get(id),
    isDeleted: (id: string) => deletions.has(id),
    names: (name: TaxonName): readonly RecordedName[] => names.get(name) ?? [],
  };
});

/** Supply an unpacked NCBI taxonomy snapshot to the NCBI lookup adapter. */
export class NcbiDump extends Context.Service<
  NcbiDump,
  Effect.Success<ReturnType<typeof openDump>>
>()("robo-taxonomist/NcbiDump") {
  /** Load the four required dump files from a directory. */
  static layerAt = (options: DumpOptions) => Layer.effect(NcbiDump, openDump(options));
}
