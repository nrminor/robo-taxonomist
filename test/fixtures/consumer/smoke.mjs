import assert from "node:assert/strict";
import { TaxonName, TaxonSet } from "robo-taxonomist";

const oaks = TaxonSet.of(TaxonName.make("Quercus"));

assert.equal(TaxonSet.union(oaks, oaks)._tag, "Union");
