import { Schema } from "effect";

/** Closed set of panel identifiers accepted by the demo request and response schemas. */
export const PanelId = Schema.Literals(["broad", "focused", "nested"]);
export type PanelId = typeof PanelId.Type;
/** Panel requested when the browser first loads, before an explicit selection. */
export const initialPanelId: PanelId = "broad";

/**
 * Authored demo records in response order, not an observed biological sample.
 * Abundances are synthetic weights totaling 100; kinds distinguish scientific names from vague labels.
 */
export const records = [
  { id: "r01", name: "Saccharomyces cerevisiae", abundance: 14, kind: "species" },
  { id: "r02", name: "Kluyveromyces lactis", abundance: 8, kind: "species" },
  { id: "r03", name: "Debaryomyces hansenii", abundance: 5, kind: "species" },
  { id: "r04", name: "Lactiplantibacillus plantarum", abundance: 12, kind: "species" },
  { id: "r05", name: "Levilactobacillus brevis", abundance: 7, kind: "species" },
  { id: "r06", name: "Lacticaseibacillus rhamnosus", abundance: 4, kind: "species" },
  { id: "r07", name: "Acetobacter aceti", abundance: 6, kind: "species" },
  { id: "r08", name: "Komagataeibacter xylinus", abundance: 4, kind: "species" },
  { id: "r09", name: "Gluconobacter oxydans", abundance: 2, kind: "species" },
  { id: "r10", name: "Streptomyces coelicolor", abundance: 5, kind: "species" },
  { id: "r11", name: "Bifidobacterium longum", abundance: 3, kind: "species" },
  { id: "r12", name: "Corynebacterium glutamicum", abundance: 2, kind: "species" },
  { id: "r13", name: "Synechococcus elongatus", abundance: 3, kind: "species" },
  { id: "r14", name: "Nostoc punctiforme", abundance: 2, kind: "species" },
  { id: "r15", name: "Prochlorococcus marinus", abundance: 1, kind: "species" },
  { id: "r16", name: "Methanococcus maripaludis", abundance: 3, kind: "species" },
  { id: "r17", name: "Methanobacterium formicicum", abundance: 2, kind: "species" },
  { id: "r18", name: "Haloferax volcanii", abundance: 1, kind: "species" },
  { id: "r19", name: "Saccharomyces", abundance: 4, kind: "genus" },
  { id: "r20", name: "Lactiplantibacillus", abundance: 3, kind: "genus" },
  { id: "r21", name: "Streptomyces", abundance: 2, kind: "genus" },
  { id: "r22", name: "Methanococcus", abundance: 1, kind: "genus" },
  { id: "r23", name: "unclassified microorganism", abundance: 4, kind: "vague" },
  {
    id: "r24",
    name: "environmental sequence; taxonomic assignment unavailable",
    abundance: 2,
    kind: "vague",
  },
] as const;

const target = (name: string, rank: string) => ({
  id: name.toLowerCase().replaceAll(" ", "-"),
  name,
  rank,
});
const fungi = target("Fungi", "kingdom");
const lactobacillaceae = target("Lactobacillaceae", "family");
const acetobacteraceae = target("Acetobacteraceae", "family");
const archaea = target("Archaea", "domain");
const saccharomyces = target("Saccharomyces", "genus");
const plantarum = target("Lactiplantibacillus plantarum", "species");
const maripaludis = target("Methanococcus maripaludis", "species");

/** Target sets in display and response order; the nested panel deliberately includes overlapping lineages. */
export const panels: ReadonlyArray<{
  readonly id: PanelId;
  readonly name: string;
  readonly description: string;
  readonly targets: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly rank: string;
  }>;
}> = [
  {
    id: "broad",
    name: "Broad groups",
    description: "Fungi, Lactobacillaceae and Archaea.",
    targets: [
      fungi,
      lactobacillaceae,
      acetobacteraceae,
      target("Actinomycetota", "phylum"),
      target("Cyanobacteriota", "phylum"),
      archaea,
    ],
  },
  {
    id: "focused",
    name: "Families, genera and species",
    description: "Acetobacteraceae, Saccharomyces and Kluyveromyces lactis.",
    targets: [
      saccharomyces,
      target("Kluyveromyces lactis", "species"),
      plantarum,
      target("Levilactobacillus", "genus"),
      acetobacteraceae,
      target("Bifidobacterium", "genus"),
      target("Streptomyces coelicolor", "species"),
      target("Nostoc", "genus"),
      target("Methanobacteriaceae", "family"),
      maripaludis,
    ],
  },
  {
    id: "nested",
    name: "Groups and subgroups",
    description: "Fungi, Saccharomyces and Saccharomyces cerevisiae in the same lineage.",
    targets: [
      fungi,
      target("Saccharomycetaceae", "family"),
      saccharomyces,
      target("Saccharomyces cerevisiae", "species"),
      target("Bacillota", "phylum"),
      lactobacillaceae,
      plantarum,
      archaea,
      target("Methanococcus", "genus"),
      maripaludis,
    ],
  },
];
