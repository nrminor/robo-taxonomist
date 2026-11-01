# robo-taxonomist: command-line edition

```text
█████▄  ▄████▄ █████▄ ▄████▄   ██████ ▄████▄ ██  ██ ▄████▄ ███  ██ ▄████▄ ██▄  ▄██ ██ ▄█████ ██████
██▄▄██▄ ██  ██ ██▄▄██ ██  ██ ▄▄▄ ██   ██▄▄██  ████  ██  ██ ██ ▀▄██ ██  ██ ██ ▀▀ ██ ██ ▀▀▀▄▄▄   ██
██   ██ ▀████▀ ██▄▄█▀ ▀████▀     ██   ██  ██ ██  ██ ▀████▀ ██   ██ ▀████▀ ██    ██ ██ █████▀   ██

(COMMAND-LINE EDITION)
```

robo-taxonomist is a command-line tool for biologists that uses decision models to resolve ambiguous taxonomic labels. Compare records, check membership in taxa or taxon sets, and classify records against a panel of taxa.

Work with labels such as `Voucher A17 | Quercus robur` or structured records containing scientific names and taxon identifiers. Keep sample IDs and other metadata alongside your records. The CLI brings the [robo-taxonomist library](../../README.md) to shell pipelines, workflows and an HTTP API.

## Install

### Build an executable

From the repository root, use [Mise](https://mise.jdx.dev/) to install the build tools pinned in [mise.toml](../../mise.toml):

```bash
mise install
mise run bootstrap
mise run cli:compile

export PATH="$PWD/artifacts/cli:$PATH"
robo-taxonomist --version
```

The executable is written to `artifacts/cli/robo-taxonomist`. Add that directory to your shell's `PATH`, or copy the executable to a directory already on `PATH`.

The executable includes its JavaScript runtime. Running it does not require a separate Node.js or Bun installation. The build targets the current host; executable checks have been run on macOS arm64.

### Run from source

After `mise install` and `mise run bootstrap`, run commands through the development recipe:

```bash
mise run cli:dev -- compare labels "Voucher A17" "Voucher A17"
```

The examples below use the executable name, `robo-taxonomist`.

### Configure a model

Set `ROBO_TAXONOMIST_MODEL` to a model available to your [TypeSafe account](https://console.typesafe.ai/) and supply `TYPESAFE_API_KEY` through your environment or secret manager:

```bash
export ROBO_TAXONOMIST_MODEL="your-model"
```

No model is selected by default. To use a different model for one command, pass `--model`:

```bash
robo-taxonomist compare identity "Quercus robur" "English oak" --model another-model
```

Model-backed commands send taxonomic inputs to TypeSafe. Exact label comparison and set construction run without a model or API key.

## Quickstart

Create a small file of record labels and classify them against two target taxa:

```bash
printf 'Quercus robur\nFagus sylvatica\n' > records.txt

robo-taxonomist classify records.txt --target Quercus --target Fagus
```

The default output is a table of records, targets, judgments, support and ranking positions. To ask one question about all the records instead:

```bash
robo-taxonomist membership all records.txt --target Fagaceae --format json
```

Use `robo-taxonomist --help` to list commands, or add `--help` to a command for its options and examples.

## Saved target sets

Create a panel once and reuse it in later commands:

```bash
robo-taxonomist set create --target Quercus --target Fagus > panel.json
robo-taxonomist classify records.txt --targets-file panel.json
```

Union describes organisms in either set, intersection those in both, and difference those in the left set but not the right. Each command saves a reusable JSON definition:

```bash
# Extend a saved panel
robo-taxonomist set union \
  --left-targets-file panel.json --right-target Betula > extended-panel.json

# Define the intersection of a genus and a family
robo-taxonomist set intersection \
  --left-target Quercus --right-target Fagaceae > oak-family.json

# Define family members other than oaks
robo-taxonomist set difference \
  --left-target Fagaceae --right-target Quercus > non-oak-fagaceae.json
```

Each operand can combine repeated target names and files into a union.

Use `set relation` to ask how two sets relate:

```bash
robo-taxonomist set relation \
  --relation subset --left-target Quercus --right-target Fagaceae --format json
```

The available relations are `subset`, `proper-subset`, `equivalent`, `overlap` and `disjoint`.

## Usage

### Classify records

A record can match both broad and specific taxa: `Quercus robur` can match both `Quercus` and `Fagaceae`. Accepted matches are ranked by support, not by taxonomic specificity.

Classify records from several files, or supply labels directly with `--record`:

```bash
robo-taxonomist classify records.txt more-records.txt --targets-file panel.json

robo-taxonomist classify \
  --record "Quercus robur voucher A17" --record "Fagus sylvatica voucher B18" \
  --targets-file panel.json
```

Use JSONL output to keep identifying fields, metadata, model answers and rankings:

```bash
robo-taxonomist classify records.jsonl \
  --targets-file panel.json --format jsonl > classification.jsonl
```

The [input formats](#input-formats) section shows how to write `records.jsonl`.

### Check membership

Check whether every subject described by a record belongs to the target:

```bash
robo-taxonomist membership check "Quercus robur voucher A17" --target Quercus
```

Partition records by membership judgment:

```bash
robo-taxonomist membership partition records.txt \
  --targets-file panel.json --format jsonl > membership.jsonl
```

The outcomes are `Member`, `NotMember`, `MixedMembership`, `Undetermined` and `MultipleTaxaInTarget`. An oak-and-beech record has mixed membership in an oak-only target, but belongs to an oak-or-beech target.

The `all`, `any` and `none` commands each return one judgment:

```bash
robo-taxonomist membership all records.txt --target Fagaceae --format json
robo-taxonomist membership any records.txt --target Quercus --format json
robo-taxonomist membership none records.txt --target Homo --format json
```

For `any`, at least one whole record must belong; a matching subject within a mixed record is not enough.

### Compare labels and taxa

Label comparison tests the exact supplied text and prints `true` or `false`:

```bash
robo-taxonomist compare labels "Voucher A17" "Voucher A17"
```

Use the model-backed commands for taxonomic identity, rank or containment:

```bash
robo-taxonomist compare identity "Quercus robur" "English oak"

robo-taxonomist compare rank \
  "Quercus robur" "Quercus petraea" --rank genus

robo-taxonomist compare containment Quercus Fagaceae
```

Rank comparison requires `--rank`. Supported ranks are `domain`, `kingdom`, `phylum`, `class`, `order`, `family`, `genus` and `species`. Containment asks whether the first taxon's organisms belong to the second taxon. Add `--format json` to retain the judgment fields as JSON.

## Input formats

The CLI accepts taxonomic records; it does not parse sequence files or look up accessions.

`--record` supplies a record label, and `--target` supplies a target name. Repeat either flag to supply more values. Record labels precede record files; target names precede target files. Values and repeated occurrences are retained.

| Format  | Record files                       | Target files                                              |
| ------- | ---------------------------------- | --------------------------------------------------------- |
| `text`  | One nonblank record label per line | One nonblank target name per line                         |
| `json`  | An array of identifying records    | An array of identifying records or a saved set definition |
| `jsonl` | One identifying record per line    | One identifying record per line                           |

The `.json` and `.jsonl` suffixes select those formats; other paths use text. Use `--records-format` or `--targets-format` to override the file format. Stdin (`-`) defaults to text and can be used only once across record and target sources.

An identifying record needs at least one of `label`, `scientificName` or `taxonId`. A taxon identifier contains `taxonomy` and `id`, with an optional `release`. Additional JSON fields are retained. For example:

```bash
cat > records.jsonl <<'JSONL'
{"label":"Voucher A17","scientificName":"Quercus robur","sampleId":"A17","abundance":12}
{"taxonId":{"taxonomy":"ncbi","id":"9606"},"sampleId":"A18"}
JSONL
```

Use `--format jsonl` for these records to retain all identifying fields and metadata. Tabular record output requires a `label`; displayed targets need a `scientificName` or `label`. Use the command's structured output for identifier-only inputs.

For structured stdin, select the input format explicitly:

```bash
cat records.jsonl | robo-taxonomist classify - \
  --records-format jsonl --targets-file panel.json --format jsonl > classification.jsonl
```

## Output and model requests

### Tables, JSON and JSONL

Results go to stdout and diagnostics go to stderr. Use shell redirection to save results. Table output includes a header; `--no-header` omits it.

The `tsv` format uses tab-delimited CSV quoting. Tabs, newlines and quotation marks inside fields are quoted or escaped. Read it with a CSV-aware reader configured with a tab delimiter.

| Commands                                                                  | Structured format | Contents                                                 |
| ------------------------------------------------------------------------- | ----------------- | -------------------------------------------------------- |
| `compare identity`, `compare rank`, `compare containment`, `set relation` | `json`            | The judgment and any rank, side or clarification target  |
| `membership check`, `membership partition`                                | `jsonl`           | A record and its judgment on each line                   |
| `membership all`, `membership any`, `membership none`                     | `json`            | One collection membership judgment                       |
| `classify`                                                                | `jsonl`           | The panel, records, matches, rankings, answers and usage |

A membership line can look like this:

```json
{ "record": "Quercus robur", "judgment": { "_tag": "Member" } }
```

Each classification JSONL line contains `panel`, `records` and `usage`. Each record has all candidate outcomes in `taxa` and accepted `Matched` entries in `ranking`, sorted by descending support. Ties retain target order. Match entries retain the judgment, support and model answer.

Support combines the model's probabilities for `sameTaxon` and `withinTaxon`, normalized over all four classification answers. Support across targets need not sum to one. It is neither an abundance estimate nor measured accuracy.

Negative and unresolved judgments are successful results. Invalid input, provider failures and output failures exit nonzero. If a command fails after writing results, the written output is incomplete; check its exit status before using it downstream.

### Batches and memory

`--batch-size` sets records per model request (default: 16); `--concurrency` sets concurrent requests (default: 1):

```bash
robo-taxonomist classify records.jsonl --targets-file panel.json \
  --format jsonl --batch-size 16 --concurrency 2 > classification.jsonl
```

`classify` and `membership partition` process groups of up to `batch-size × concurrency` records. Classification JSONL writes one result per group. Partition JSONL writes one record per line in judgment-bucket order within each group, preserving input order within each bucket.

Text and JSONL record files are streamed. JSON arrays are loaded one file at a time. Target sets remain in memory, and `all`, `any` and `none` load all records before processing.

## Command reference

| Command                               | Action                                                            |
| ------------------------------------- | ----------------------------------------------------------------- |
| `compare labels LEFT RIGHT`           | Compare exact label text                                          |
| `compare identity LEFT RIGHT`         | Ask whether two taxonomic names identify the same taxon           |
| `compare rank LEFT RIGHT --rank RANK` | Compare records at a selected rank                                |
| `compare containment INNER OUTER`     | Ask whether the inner taxon's organisms belong to the outer taxon |
| `set create`                          | Create a set from `--target` and `--targets-file` sources         |
| `set union`                           | Combine the left and right sets                                   |
| `set intersection`                    | Define organisms belonging to both sets                           |
| `set difference`                      | Subtract the right set from the left                              |
| `set relation --relation RELATION`    | Ask a relationship question about two sets                        |
| `membership check RECORD`             | Check one record label against a target                           |
| `membership partition [FILES…]`       | Group records by membership judgment                              |
| `membership all [FILES…]`             | Ask whether every record belongs to the target                    |
| `membership any [FILES…]`             | Ask whether at least one record belongs to the target             |
| `membership none [FILES…]`            | Ask whether no records belong to the target                       |
| `classify [FILES…]`                   | Classify records against a panel                                  |
| `server`                              | Start the foreground HTTP API                                     |

Binary set commands use `--left-target`, `--left-targets-file`, `--left-targets-format` and their `--right-*` counterparts. Other target-taking commands use the unprefixed flags.

Use `robo-taxonomist COMMAND --help` for command options and examples. The root help lists aliases, and `--wizard` starts an interactive command walkthrough.

## Server mode

Start the HTTP API with the model already configured in the environment:

```bash
robo-taxonomist server
```

The default address is `http://127.0.0.1:3000`. Open `/docs` for interactive API documentation or `/openapi.json` for the generated API definition. Press Ctrl-C to stop. Readiness and request logs go to stderr.

CLI commands run without the server. HTTP requests use the model selected at server startup.

For example, using curl:

```bash
curl --fail-with-body http://127.0.0.1:3000/classify \
  -H 'content-type: application/json' \
  -d '{"records":["Quercus robur","Fagus sylvatica"],"panel":"Fagaceae"}'
```

All operation endpoints use `POST`:

| Path                    | Request fields                    | Action                                          |
| ----------------------- | --------------------------------- | ----------------------------------------------- |
| `/compare/labels`       | `left`, `right`                   | Exact label equality                            |
| `/compare/identity`     | `left`, `right`                   | Taxon identity                                  |
| `/compare/containment`  | `inner`, `outer`                  | Taxon containment                               |
| `/compare/rank`         | `left`, `right`; query `rank`     | Rank comparison                                 |
| `/sets/create`          | `targets`                         | Create a target set                             |
| `/sets/union`           | `left`, `right`                   | Union                                           |
| `/sets/intersection`    | `left`, `right`                   | Intersection                                    |
| `/sets/difference`      | `left`, `right`                   | Difference                                      |
| `/sets/relation`        | `left`, `right`; query `relation` | Set relationship                                |
| `/membership/check`     | `record`, `target`                | Record membership                               |
| `/membership/partition` | `records`, `target`               | Membership buckets                              |
| `/membership/all`       | `records`, `target`               | All-record membership                           |
| `/membership/any`       | `records`, `target`               | Any-record membership                           |
| `/membership/none`      | `records`, `target`               | No-record membership                            |
| `/classify`             | `records`, `panel`                | Classification with matches, rankings and usage |

Records accept labels or identifying record objects. Set operands accept target names, identifying records or saved set definitions. HTTP partition results contain the five membership buckets; CLI partition JSONL writes one record and judgment per line.

### Request limits

These limits apply to each HTTP request and are selected when the server starts:

| Flag                        | Default         | Limit                                                              |
| --------------------------- | --------------- | ------------------------------------------------------------------ |
| `--max-body-bytes`          | 1048576 (1 MiB) | Request body bytes                                                 |
| `--request-timeout-ms`      | 60000 (60 s)    | Time to read and process a request                                 |
| `--max-json-depth`          | 64              | Nested JSON objects and arrays, including metadata                 |
| `--max-records`             | 1000            | Records in a membership or classification request                  |
| `--max-targets`             | 100             | Target-taxon occurrences in a membership or classification request |
| `--max-record-target-pairs` | 10000           | Records × target-taxon occurrences                                 |

Repeated targets count separately, including taxa in the subtracted side of a set. Collection limits reject excess work before inference. A request that exceeds its time limit interrupts ongoing work. Batch size and concurrency can also be set at startup with `--batch-size` and `--concurrency`.

Use `--host` and `--port` to change the bind address. `--port 0` selects an available port. **The server has no authentication.** Keep the default loopback address or provide external access controls.

## Workflow use

Run the CLI as an ordinary task executable. Make it available on the worker's `PATH`, provide the model environment and credentials through the workflow's configuration, and capture stdout as a task output.

For example, a Nextflow process can classify staged record and panel files:

```groovy
process CLASSIFY {
    input:
    path records
    path panel

    output:
    path 'classification.jsonl'

    script:
    """
    robo-taxonomist classify "${records}" --targets-file "${panel}" \\
        --format jsonl > classification.jsonl
    """
}
```

## Development

Run the CLI's build, type and behavior checks from the repository root:

```bash
mise run cli:check
```

To rebuild and check the host executable outside the source checkout:

```bash
mise run cli:smoke
```

The automated checks use provider fixtures and do not make live model requests. CLI source is in [src](src); the library API and its examples are documented in the [repository README](../../README.md).

## License

[MIT](LICENSE). Copyright © 2026 Nick Minor.
