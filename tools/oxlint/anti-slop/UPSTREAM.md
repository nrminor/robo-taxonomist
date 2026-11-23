# Upstream

The `rules/`, `shared/`, `effect/`, and `vendor/eslint-stylistic/` files come from `src/` in [K-Mistele/anti-slop at `13b020367525e8c6efe6cede8f387697b2a8d907`](https://github.com/K-Mistele/anti-slop/tree/13b020367525e8c6efe6cede8f387697b2a8d907). K-Mistele's project is a fork of [Dillon Mulroy's anti-slop](https://github.com/dmmulroy/anti-slop). See `LICENSE` and the license and upstream record in `vendor/eslint-stylistic/`.

The TypeScript files use the repository's formatter. The local `index.ts` registers selected rules without the upstream changed-lines wrapper, installers, hooks, integrity runner, or model backends. Rule scope and severity are set in the repository's `.oxlintrc.json`. When updating, compare the incoming rule and its tests with the recorded revision rather than replacing the local plugin with the upstream preset.

`require-named-adapter-constructor` and its tests are local. Unlike upstream's `require-service-make-layer`, it checks the constructor expression at `Layer.effect`, not the service class. It requires a named reference or factory call; it does not trace ownership across files.
