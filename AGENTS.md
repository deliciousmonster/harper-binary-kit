# AGENTS.md

For whoever changes this repository. `README.md` is for whoever uses it.

## What this is

The packaging half of shipping a native binary from a Harper component, taken out of
`@deliciousmonster/datadog-agent-binary` where it was written first. That plugin spent 2,680 lines on
`src/` and `scripts/`, and about 800 of them had nothing to do with Datadog. Any plugin shipping a binary
writes the same 800 again.

Three entry points, and the first split is load-bearing:

- `./resolve` runs inside a Harper node. No dependencies, and it must stay that way.
- `./cli` runs on a CI runner. It may grow dependencies; nothing a customer installs loads it.
- `./layout` is the path convention both halves and the consumer's own build step read. It is separate
  because a build has to write `build/<target>/bin` before any of this runs, and a build that hardcodes that
  is the fifth process agreeing with a declaration nothing checks it against.

## Why they are one package

`stage.js` generates the `index.js` that exports `getBinaryPath`. `resolve.js` is the only thing that calls
it. Before this package those two halves lived in two repositories with nothing asserting they agreed, and the
plugin caught a mismatch only because it happened to own both ends.

`test/unit/contract.test.js` is what keeps that honest, and it is the first file to read. Every case stages a
real package into a temp directory and resolves a binary back out of it. A resolver driven by a hand-written
fake proves nothing about the module the staging writes, and a staging test that reads its own output proves
nothing about what a consumer does with it.

## Layout

Ten files under `src/`, ESM with `// @ts-check` and JSDoc, nothing built.

- `targets.js`: the three vocabularies a platform package lives in - node's `process.platform`/`process.arch`, npm's `os`/`cpu`, and the label the packages publish under. They disagree on every axis.
- `layout.js`: `build/<target>/bin` and `npm/<name>`. Four processes meet at these paths and none can see the others.
- `packages.js`: which variant carries what on which target, and what `optionalDependencies` should say.
- `stage.js`: build tree to publishable package, including the generated `index.js`.
- `resolve.js`: the runtime half. Asks each installed platform package by filename and checks the filename that comes back.
- `verify.js`: what `npm pack` WOULD ship, per package, plus the declared symbols.
- `floor.js`: the symbol versions a binary needs against what the target image provides.
- `publish.js`: attempt every package, derive the dist-tag, advance `latest` forward only.
- `published.js`: read the registry back, at the version endpoint.
- `cli.js`: one command per step.

## The rule every file here follows

Each one exists because something shipped. A comment that says only what the code does is worth deleting; one
that says what went wrong without it is the reason the file is not simpler. Where a number is in the source -
a timeout, a threshold, a retry count - it was measured, and the measurement is in the comment beside it.

Nothing here may report success having done nothing. That is the failure mode this whole package is about:
a staging that wrote no package, a publish that published nothing, a gate whose glob matched no files. Every
step that can be a no-op says so loudly instead.

## Commands

`npm test` is `node --test`, no build. `npm run typecheck` is `tsc --noEmit`, and it covers `test/` too.
`test.yml` runs `format:check`, `lint`, `typecheck` and `test` on Linux, macOS and Windows against Node 22
and 24, and refuses a run whose test glob matched nothing.

## Voice

`jaxontalk` applies to all prose here, including code comments, commit messages and this file. No em dashes,
no rule-of-three, no reader-validation, lead with the claim.
