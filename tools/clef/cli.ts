/// <reference types="node" />

import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { Config, Console, Data, Effect, HashMap, Match, Option, Schema } from "effect";
import { askClefLive, LocationQuestion, VerdictQuestion } from "./clef.ts";
import { effectSourceJevRules, effectTestJevRules } from "./effect-rules.ts";

const credentials = Config.all({
  accountId: Config.String("CLOUDFLARE_ACCOUNT_ID"),
  token: Config.Redacted("CLOUDFLARE_API_TOKEN"),
});

class ReviewInputError extends Data.TaggedError("ReviewInputError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const git = (...args: ReadonlyArray<string>) =>
  execFileSync("git", [...args], { encoding: "utf8" });

const readWorkingFile = (root: string, path: string) => {
  const actual = realpathSync(resolve(root, path));
  const withinRoot = relative(root, actual);

  if (withinRoot === ".." || withinRoot.startsWith(`..${sep}`) || isAbsolute(withinRoot)) {
    throw new ReviewInputError({ message: `Review path resolves outside the repository: ${path}` });
  }

  return readFileSync(actual, "utf8");
};

const readCommittedFile = (root: string, commit: string, path: string) => {
  const entry = git("-C", root, "--literal-pathspecs", "ls-tree", "-z", commit, "--", path);

  if (!/^100(?:644|755) blob /.test(entry)) {
    throw new ReviewInputError({ message: "Clef can review only regular source files." });
  }

  return git("-C", root, "cat-file", "blob", `${commit}:${path}`);
};

const target = Schema.TaggedUnion({
  WorkingTree: { base: Schema.String },
  PinnedRevision: { base: Schema.String, commit: Schema.String },
});

const changedFiles = (input: typeof target.Type) =>
  Effect.try({
    try: () => {
      const root = git("rev-parse", "--show-toplevel").trim();

      const selection = Match.value(input).pipe(
        Match.tagsExhaustive({
          WorkingTree: () => ({
            revision: "HEAD",
            diffTarget: [],
            untracked: git("-C", root, "ls-files", "--others", "--exclude-standard", "-z"),
            read: (path: string) => readWorkingFile(root, path),
          }),
          PinnedRevision: ({ commit }) => ({
            revision: commit,
            diffTarget: [commit],
            untracked: "",
            read: (path: string) => readCommittedFile(root, commit, path),
          }),
        }),
      );

      const mergeBase = git("-C", root, "merge-base", "--", input.base, selection.revision).trim();

      const changed = git(
        "-C",
        root,
        "diff",
        "--no-ext-diff",
        "--no-renames",
        "--diff-filter=ACMT",
        "--name-only",
        "-z",
        mergeBase,
        ...selection.diffTarget,
        "--",
      );

      const paths = new Set([...changed.split("\0"), ...selection.untracked.split("\0")]);

      return [...paths]
        .sort((left, right) => left.localeCompare(right))
        .flatMap((path) => {
          if (!/^(?:src|test|apps\/[^/]+\/(?:src|test))\/.*\.[cm]?tsx?$/.test(path)) return [];

          return [{ path, source: selection.read(path) }];
        });
    },
    catch: (cause) =>
      new ReviewInputError({
        message:
          "Could not read changed files. Run from the repository root and check the base ref.",
        cause,
      }),
  });

const rulesFor = (path: string) =>
  /(?:^|\/)test\/|[.](?:test|spec)[.]/.test(path) ? effectTestJevRules : effectSourceJevRules;

const reviewFile = Effect.fn("Review.file")(function* (
  file: { readonly path: string; readonly source: string },
  auth: Config.Success<typeof credentials>,
) {
  const lines = file.source.split("\n");
  const numberedSource = lines.map((line, i) => `${i + 1}: ${line}`).join("\n");
  const width = Math.max(1, Math.ceil(lines.length / 60));
  const starts = Array.from({ length: Math.ceil(lines.length / width) }, (_, i) => i * width + 1);

  const ranges = new Map<string, string>(
    starts.map((start) => [
      `L${start}`,
      `Lines ${start}–${Math.min(lines.length, start + width - 1)}`,
    ]),
  );

  ranges.set("unclear", "No clear location");
  const candidates = Object.fromEntries(ranges);

  const lineById = HashMap.fromIterable<string, number>(
    starts.map((start) => [`L${start}`, start]),
  );

  const rules = rulesFor(file.path);

  const questions = rules.flatMap((rule) => [
    new VerdictQuestion({ id: rule.id, instructions: rule.question }),
    new LocationQuestion({
      id: `${rule.id}.location`,
      instructions: `${rule.question} ${rule.location.question} Select unclear if there is no clear violation.`,
      candidates,
    }),
  ]);

  const answers = yield* askClefLive({
    state: { path: file.path, numberedSource },
    questions,
    credentials: auth,
  });

  const byId = HashMap.fromIterable(answers.map((answer) => [answer.id, answer] as const));

  return rules.flatMap((rule) => {
    const verdict = HashMap.get(byId, rule.id);

    const report = Option.exists(
      verdict,
      Match.type<(typeof answers)[number]>().pipe(
        Match.when(
          { probability: Schema.is(Schema.Finite) },
          ({ probability }) => probability >= rule.cutoff,
        ),
        Match.orElse(() => false),
      ),
    );

    if (!report) return [];

    const line = HashMap.get(byId, `${rule.id}.location`).pipe(
      Option.flatMap(
        Match.type<(typeof answers)[number]>().pipe(
          Match.when(
            { choice: Schema.is(Schema.String), confidence: Schema.is(Schema.Finite) },
            ({ choice, confidence }) =>
              confidence >= rule.location.cutoff ? HashMap.get(lineById, choice) : Option.none(),
          ),
          Match.orElse(() => Option.none()),
        ),
      ),
      Option.getOrElse(() => 1),
    );

    const reportPath = file.path.replaceAll(/[\r\n\t]/g, " ");

    return [`${reportPath}:${line}: clef/${rule.id}: ${rule.question}`];
  });
});

const args = process.argv.slice(2);

const usage = "Usage: review:clef [--smoke | --base <ref> [--commit <sha>] | --help]";

const mode = Schema.TaggedUnion({
  Help: {},
  Smoke: {},
  Review: { target },
});

const commitSha = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/));

const noArgs = Schema.is(Schema.Tuple([]));

const helpArgs = Schema.is(Schema.Tuple([Schema.Literal("--help")]));

const smokeArgs = Schema.is(Schema.Tuple([Schema.Literal("--smoke")]));

const workingArgs = Schema.is(Schema.Tuple([Schema.Literal("--base"), Schema.String]));

const pinnedArgs = Schema.is(
  Schema.Tuple([Schema.Literal("--base"), commitSha, Schema.Literal("--commit"), commitSha]),
);

const parseArgs = Match.value(args).pipe(
  Match.when(noArgs, () => {
    const workingTree = target.cases.WorkingTree.make({ base: "main" });

    return Effect.succeed(mode.cases.Review.make({ target: workingTree }));
  }),
  Match.when(helpArgs, () => Effect.succeed(mode.cases.Help.make({}))),
  Match.when(smokeArgs, () => Effect.succeed(mode.cases.Smoke.make({}))),
  Match.when(workingArgs, ([, base]) => {
    const workingTree = target.cases.WorkingTree.make({ base });

    return Effect.succeed(mode.cases.Review.make({ target: workingTree }));
  }),
  Match.when(pinnedArgs, ([, base, , commit]) => {
    const pinnedRevision = target.cases.PinnedRevision.make({ base, commit });

    return Effect.succeed(mode.cases.Review.make({ target: pinnedRevision }));
  }),
  Match.orElse(() => new ReviewInputError({ message: usage })),
);

const program = parseArgs.pipe(
  Effect.flatMap(
    Match.type<typeof mode.Type>().pipe(
      Match.tagsExhaustive({
        Help: () => Console.log(usage).pipe(Effect.as(0)),
        Smoke: () =>
          Effect.gen(function* () {
            const auth = yield* credentials;
            yield* askClefLive({
              state: { path: "synthetic.ts", numberedSource: "1: export const answer = 42;" },
              questions: [
                new VerdictQuestion({
                  id: "smoke",
                  instructions: "Does this file export a constant named answer?",
                }),
                new LocationQuestion({
                  id: "smoke.location",
                  instructions: "On which line is the exported constant?",
                  candidates: { L1: "Line 1", unclear: "No clear location" },
                }),
              ],
              credentials: auth,
            });
            yield* Console.log(
              "Clef accepted the synthetic request. No repository source was sent.",
            );

            return 0;
          }),
        Review: ({ target }) =>
          Effect.gen(function* () {
            const files = yield* changedFiles(target);

            if (files.length === 0) {
              yield* Console.log("No changed TypeScript source or test files to review.");

              return 0;
            }

            const auth = yield* credentials;
            const findings = yield* Effect.forEach(files, (file) => reviewFile(file, auth));
            const lines = findings.flat();
            yield* Effect.forEach(lines, (line) => Console.error(line), { discard: true });
            yield* Console.log(`Clef reviewed ${files.length} files: ${lines.length} findings.`);

            return lines.length === 0 ? 0 : 1;
          }),
      }),
    ),
  ),
  Effect.catchTag("ReviewInputError", ({ message }) => Console.error(message).pipe(Effect.as(2))),
  Effect.catch(() =>
    Console.error(
      "Clef review could not complete. Check the arguments, base ref, credentials, and Workers AI access.",
    ).pipe(Effect.as(2)),
  ),
);

process.exitCode = await Effect.runPromise(program);
