import assert from "node:assert/strict";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option, Path, Schema, SchemaIssue } from "effect";
import {
  Errors,
  IdLookup,
  NcbiDump,
  NcbiTaxonId,
  NcbiTaxonomy,
  TaxonLookup,
  TaxonName,
} from "robo-taxonomist";

const row = (...fields: readonly string[]) => `${fields.join("\t|\t")}\t|\n`;

const ncbiId = (id: string) => NcbiTaxonId.make({ id });

it("constructs a validated NCBI identifier without repeating the taxonomy", () => {
  const oakId = NcbiTaxonId.make({ id: "58334", release: "2025-07-01" });
  const encoded = Schema.encodeSync(NcbiTaxonId)(oakId);

  expect(encoded).toEqual({ taxonomy: "ncbi", id: "58334", release: "2025-07-01" });
});

it.effect("rejects malformed identifiers through the effectful constructor", () =>
  Effect.gen(function* () {
    const failure = yield* NcbiTaxonId.makeEffect({ id: "not-an-id" }).pipe(Effect.flip);

    expect(SchemaIssue.isIssue(failure)).toBe(true);
  }),
);

it.effect("requires the taxonomy field when decoding an NCBI identifier", () =>
  Effect.gen(function* () {
    const decode = Schema.decodeUnknownEffect(NcbiTaxonId);
    const failure = yield* decode({ id: "58334" }).pipe(Effect.flip);

    expect(Schema.isSchemaError(failure)).toBe(true);
  }),
);

const files = {
  "nodes.dmp": row("1", "1", "no rank") + row("2", "1", "genus") + row("3", "2", "species"),
  "names.dmp":
    row("1", "root", "", "scientific name") +
    row("2", "Quercus", "", "scientific name") +
    row("3", "Quercus robur", "", "scientific name"),
  "merged.dmp": "",
  "delnodes.dmp": "",
};

const writeDump = Effect.fnUntraced(function* (contents: Readonly<Record<string, string>> = files) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped();

  for (const [filename, text] of Object.entries(contents)) {
    yield* fs.writeFileString(path.join(directory, filename), text);
  }

  return directory;
});

const lookup = (directory: string) =>
  NcbiTaxonomy.layer.pipe(Layer.provide(NcbiDump.layerAt({ directory, release: "fixture" })));

const dumpIssueOf = (failure: unknown) => {
  assert(failure instanceof Errors.InconsistentNcbiDump);

  return failure.reason;
};

it.effect("loads the recorded genus from an unpacked NCBI snapshot", () =>
  Effect.gen(function* () {
    const directory = yield* writeDump();
    const id = ncbiId("3");
    const genus = yield* TaxonLookup.genusOf(id).pipe(Effect.provide(lookup(directory)));

    expect(Option.getOrThrow(genus)).toMatchObject({
      taxonId: { taxonomy: "ncbi", id: "2", release: "fixture" },
      scientificName: "Quercus",
      rank: "genus",
    });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("retains the requested identifier and resolves the canonical taxon after a merge", () =>
  Effect.gen(function* () {
    const directory = yield* writeDump({ ...files, "merged.dmp": row("8", "3") });
    const id = ncbiId("8");
    const result = yield* TaxonLookup.byId(id).pipe(Effect.provide(lookup(directory)));

    expect(IdLookup.guards.Merged(result)).toBe(true);
    expect(result).toMatchObject({
      requested: id,
      entry: { taxon: { taxonId: { taxonomy: "ncbi", id: "3", release: "fixture" } } },
    });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("distinguishes a recorded deletion from an unknown ID", () =>
  Effect.gen(function* () {
    const directory = yield* writeDump({ ...files, "delnodes.dmp": row("9") });
    const deleted = ncbiId("9");
    const unknown = ncbiId("10");

    const results = yield* Effect.all([TaxonLookup.byId(deleted), TaxonLookup.byId(unknown)]).pipe(
      Effect.provide(lookup(directory)),
    );

    expect(results).toEqual([
      IdLookup.cases.Deleted.make({ requested: deleted }),
      IdLookup.cases.NotFound.make({ requested: unknown }),
    ]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("finds recorded scientific synonyms but not common names", () =>
  Effect.gen(function* () {
    const directory = yield* writeDump({
      ...files,
      "names.dmp":
        files["names.dmp"] +
        row("3", "Quercus pedunculata", "", "synonym") +
        row("3", "English oak", "", "common name"),
    });

    const synonym = TaxonName.make("Quercus pedunculata");
    const common = TaxonName.make("English oak");

    const results = yield* Effect.all([
      TaxonLookup.byName(synonym),
      TaxonLookup.byName(common),
    ]).pipe(Effect.provide(lookup(directory)));

    expect(results).toMatchObject([
      [{ taxon: { scientificName: "Quercus robur" }, matchedName: synonym, nameClass: "synonym" }],
      [],
    ]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("rejects a cyclic parent graph before publishing the lookup", () =>
  Effect.gen(function* () {
    const directory = yield* writeDump({
      ...files,
      "nodes.dmp": row("1", "1", "no rank") + row("2", "3", "genus") + row("3", "2", "species"),
    });

    const id = ncbiId("1");

    const failure = yield* TaxonLookup.byId(id).pipe(
      Effect.provide(lookup(directory)),
      Effect.flip,
    );

    const issue = dumpIssueOf(failure);
    expect(issue).toSatisfy(Errors.NcbiDumpIssue.guards.ParentCycle);
    expect(failure).toMatchObject({ directory, reason: { id: "2" } });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("rejects a recorded merge with no current destination instead of reporting a miss", () =>
  Effect.gen(function* () {
    const directory = yield* writeDump({ ...files, "merged.dmp": row("8", "30") });
    const id = ncbiId("8");

    const failure = yield* TaxonLookup.byId(id).pipe(
      Effect.provide(lookup(directory)),
      Effect.flip,
    );

    const issue = dumpIssueOf(failure);
    expect(issue).toSatisfy(Errors.NcbiDumpIssue.guards.MissingMergeTarget);
    expect(failure).toMatchObject({ directory, reason: { id: "8", targetId: "30" } });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("rejects two different destinations for one retired ID", () =>
  Effect.gen(function* () {
    const directory = yield* writeDump({ ...files, "merged.dmp": row("8", "2") + row("8", "3") });

    const failure = yield* TaxonLookup.byId(ncbiId("8")).pipe(
      Effect.provide(lookup(directory)),
      Effect.flip,
    );

    const issue = dumpIssueOf(failure);
    expect(issue).toSatisfy(Errors.NcbiDumpIssue.guards.ConflictingMergeTargets);
    expect(issue).toMatchObject({ id: "8", first: "2", second: "3", line: 2 });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("rejects a current ID that is also recorded as deleted", () =>
  Effect.gen(function* () {
    const directory = yield* writeDump({ ...files, "delnodes.dmp": row("3") });
    const id = ncbiId("3");

    const failure = yield* TaxonLookup.byId(id).pipe(
      Effect.provide(lookup(directory)),
      Effect.flip,
    );

    const issue = dumpIssueOf(failure);
    expect(issue).toSatisfy(Errors.NcbiDumpIssue.guards.ConflictingTaxonStatus);
    expect(failure).toMatchObject({
      directory,
      reason: { id: "3", existing: "current", incoming: "deleted" },
    });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("rejects competing scientific names for one current ID", () =>
  Effect.gen(function* () {
    const directory = yield* writeDump({
      ...files,
      "names.dmp": files["names.dmp"] + row("3", "Quercus petraea", "", "scientific name"),
    });

    const id = ncbiId("3");

    const failure = yield* TaxonLookup.byId(id).pipe(
      Effect.provide(lookup(directory)),
      Effect.flip,
    );

    const issue = dumpIssueOf(failure);
    expect(issue).toSatisfy(Errors.NcbiDumpIssue.guards.ScientificNameCount);
    expect(issue).toMatchObject({ id: "3", count: 2 });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("rejects a duplicate current identifier instead of overwriting its node", () =>
  Effect.gen(function* () {
    const directory = yield* writeDump({
      ...files,
      "nodes.dmp": files["nodes.dmp"] + row("3", "1", "species"),
    });

    const id = ncbiId("3");

    const failure = yield* TaxonLookup.byId(id).pipe(
      Effect.provide(lookup(directory)),
      Effect.flip,
    );

    const issue = dumpIssueOf(failure);
    expect(issue).toSatisfy(Errors.NcbiDumpIssue.guards.DuplicateTaxonNode);
    expect(issue).toMatchObject({ id: "3", line: 4 });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("rejects a name for a missing node even when it is not a scientific name", () =>
  Effect.gen(function* () {
    const directory = yield* writeDump({
      ...files,
      "names.dmp": files["names.dmp"] + row("99", "English oak", "", "common name"),
    });

    const failure = yield* TaxonLookup.byId(ncbiId("3")).pipe(
      Effect.provide(lookup(directory)),
      Effect.flip,
    );

    const issue = dumpIssueOf(failure);
    expect(issue).toSatisfy(Errors.NcbiDumpIssue.guards.NameWithoutTaxon);
    expect(issue).toMatchObject({ id: "99", line: 4 });
  }).pipe(Effect.provide(NodeServices.layer)),
);
