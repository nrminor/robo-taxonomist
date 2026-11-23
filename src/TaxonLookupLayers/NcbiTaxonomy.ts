import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Errors from "../errors.ts";
import * as Lookup from "../TaxonLookup.ts";
import { TaxonomicRank, TaxonName, type TaxonId } from "../schemas.ts";
import * as Dump from "./NcbiDump.ts";

const isRank = Schema.is(TaxonomicRank);

const decodeId = Schema.decodeUnknownEffect(Dump.NcbiTaxonId);

const decodeName = Schema.decodeEffect(TaxonName);

/** Provide TaxonLookup from the configured NCBI dump. */
export const layer = Layer.effect(
  Lookup.TaxonLookup,
  Effect.gen(function* () {
    const dump = yield* Dump.NcbiDump;
    const { source } = dump;

    const summarize = (id: string) => {
      const node = dump.node(id);

      if (node?.scientificName === undefined) return undefined;

      const { rank, scientificName } = node;

      const taxonId =
        source.release === undefined
          ? { taxonomy: source.taxonomy, id }
          : { taxonomy: source.taxonomy, id, release: source.release };

      return {
        taxonId,
        scientificName,
        ...(isRank(rank) ? { rank } : {}),
        sourceRank: rank,
      };
    };

    const byId = Effect.fn("NcbiTaxonomy.byId")(function* (requested: TaxonId) {
      if (!Lookup.servesId(source, requested)) {
        return yield* new Errors.TaxonSourceMismatch({ requested, provided: source });
      }

      const id = yield* decodeId(requested).pipe(Effect.mapError(Errors.InvalidInput.from));

      if (dump.isDeleted(id.id)) {
        return Lookup.IdLookup.cases.Deleted.make({ requested });
      }

      const replacement = dump.replacement(id.id);
      const canonicalId = replacement ?? id.id;
      const taxon = summarize(canonicalId);

      if (taxon === undefined) return Lookup.IdLookup.cases.NotFound.make({ requested });

      const ancestors: Lookup.TaxonSummary[] = [];
      let current = canonicalId;

      while (true) {
        const node = dump.node(current);

        if (node === undefined || node.parent === current) break;

        const ancestor = summarize(node.parent);

        if (ancestor === undefined) break;

        ancestors.push(ancestor);
        current = node.parent;
      }

      const entry = { taxon, ancestors };

      if (replacement !== undefined) {
        return Lookup.IdLookup.cases.Merged.make({ requested, entry });
      }

      return Lookup.IdLookup.cases.Found.make({ entry });
    });

    const byName = Effect.fn("NcbiTaxonomy.byName")(function* (name: TaxonName) {
      const matchedName = yield* decodeName(name).pipe(Effect.mapError(Errors.InvalidInput.from));
      const hits: Lookup.NameHit[] = [];

      for (const { id, nameClass } of dump.names(matchedName)) {
        const taxon = summarize(id);

        if (taxon !== undefined) hits.push({ taxon, matchedName, nameClass });
      }

      return hits;
    });

    return Lookup.TaxonLookup.of({ source, byId, byName });
  }),
);
