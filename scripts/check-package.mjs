import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { buildSync } from "esbuild";

const root = dirname(import.meta.dirname);
const require = createRequire(import.meta.url);
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

function run(command, args, cwd) {
  execFileSync(command, args, { cwd, stdio: "inherit" });
}

function check() {
  assert.equal(process.argv.length, 3, "Usage: mise run check:package -- <package.tgz>");
  const tarball = resolve(process.argv[2]);
  assert(tarball.endsWith(".tgz") && lstatSync(tarball).isFile(), "Expected a .tgz package file");
  const consumer = mkdtempSync(join(tmpdir(), "robo-taxonomist-consumer-"));
  try {
    writeFileSync(
      join(consumer, "package.json"),
      JSON.stringify({
        name: "robo-taxonomist-package-check",
        private: true,
        type: "module",
        dependencies: {
          "robo-taxonomist": `file:${tarball}`,
          effect: manifest.peerDependencies.effect,
        },
      }),
    );
    run(
      "pnpm",
      [
        "install",
        "--prefer-offline",
        "--ignore-scripts",
        "--ignore-workspace",
        "--config.auto-install-peers=false",
      ],
      consumer,
    );

    const installed = realpathSync(join(consumer, "node_modules/robo-taxonomist"));
    assert.deepEqual(readdirSync(installed).sort(), [
      "LICENSE",
      "README.md",
      "dist",
      "package.json",
    ]);
    for (const file of ["LICENSE", "README.md", "dist/index.js", "dist/index.d.ts"]) {
      assert(lstatSync(join(installed, file)).size > 0, `Artifact missing or empty: ${file}`);
    }
    const packed = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
    assert.equal(packed.name, manifest.name);
    assert.equal(packed.version, manifest.version);
    assert.equal(packed.type, "module");
    assert.equal(packed.types, "./dist/index.d.ts");
    assert.deepEqual(packed.exports, manifest.exports);
    assert.deepEqual(packed.peerDependencies, manifest.peerDependencies);

    const fixtures = join(root, "test/fixtures/consumer");
    for (const file of ["contracts.ts", "smoke.mjs"]) {
      copyFileSync(join(fixtures, file), join(consumer, file));
    }
    const config = JSON.parse(readFileSync(join(fixtures, "tsconfig.json"), "utf8"));
    config.extends = join(root, "tsconfig.json");
    writeFileSync(join(consumer, "tsconfig.json"), JSON.stringify(config));
    const compiler = join(dirname(require.resolve("typescript/package.json")), "bin/tsc");
    run(process.execPath, [compiler, "--project", join(consumer, "tsconfig.json")], consumer);
    run(process.execPath, [join(consumer, "smoke.mjs")], consumer);

    writeFileSync(
      join(consumer, "browser.mjs"),
      `import { Effect } from "effect";
import { RecordLabel, TaxonName, Taxonomy, TaxonSet } from "robo-taxonomist";
export const target = TaxonSet.of(TaxonName.make("Quercus"));
export const deterministic = Effect.runSync(TaxonSet.isSubsetOf(TaxonSet.empty(), target));
export const modelEffect = Taxonomy.sameSpecies(RecordLabel.make("Quercus robur"), RecordLabel.make("Quercus petraea"));
export const collection = Taxonomy.partitionRecordsByMembership([{ label: RecordLabel.make("Quercus robur") }], target);
`,
    );
    buildSync({
      entryPoints: [join(consumer, "browser.mjs")],
      bundle: true,
      platform: "browser",
      format: "esm",
      outfile: join(consumer, "browser.bundle.mjs"),
      logLevel: "info",
    });
    console.log("Packed JavaScript, declarations, runtime smoke, and basic browser bundle passed.");
  } finally {
    rmSync(consumer, { recursive: true, force: true });
  }
}

try {
  check();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
