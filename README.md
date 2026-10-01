# robo-taxonomist

An Effect-based TypeScript library being designed to reconcile taxonomic metadata across databases and express relations between taxa and groups of taxa. The intended runtime targets are browsers and backends, with provider-neutral decision-model integration.

This repository currently contains the toolchain and an empty ESM entrypoint, not a taxonomy API. The test checks the Effect/Vitest integration only.

## Development

Install [mise](https://mise.jdx.dev/) and Git, then review and trust the project configuration:

```sh
mise trust
mise bootstrap --only repos,tools,task
mise run check
```

Bootstrap installs the pinned Node.js and pnpm versions, installs dependencies from `pnpm-lock.yaml`, and checks out Discern and Effect as reference source. To install only the development toolchain and dependencies, omit `repos` from `--only`.

`mise run check` checks formatting, runs type-aware Oxlint, TypeScript and Effect diagnostics, tests, Knip, and an ESM/declaration build. Use `mise run fmt` to format files or `mise run test:watch` while developing. Package scripts contain the commands; mise tasks expose them with the pinned tooling.

Library source is checked without ambient Node.js globals. Tests and tooling have their own TypeScript configuration. Effect diagnostics run separately through `@effect/tsgo`; no compiler or linter binaries are patched.

`@effect/tsgo` uses `@effect/language-service` as its TypeScript plugin identifier. Knip excludes that identifier from dependency checks because it is supplied by `@effect/tsgo`, not a separate installed package.

The deny-by-default `.gitignore` requires an explicit allowlist entry for new file types or directories intended for version control.

## Package

`mise run build` emits ESM and declarations into `dist/`. The package exposes one root entrypoint and declares Effect 4 as a peer dependency. It does not provide a CommonJS build. `pnpm pack` rebuilds before creating an archive; only `dist/` and standard package metadata, README, and license files are included.

## License

[MIT](LICENSE).
