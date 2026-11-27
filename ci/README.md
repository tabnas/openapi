# ci/

The script the Rust gate runs, [`rust/run.sh`](rust/run.sh), and notes on
this repository's own CI workflows. `.github/workflows/rust.yml` calls
that script, and you can run it locally too.

The workflows themselves live in `.github/workflows/`. To change CI, edit
them there in a reviewed pull request. Whether a session can push such an
edit depends on its token: admin `DECISIONS.md` ADR-8, as amended on
2026-09-24, allows it, but a token without GitHub's `workflow` scope is
refused, by `git push` and by the API alike. A session refused that way
stages the workflow here, under [`workflows/`](workflows/), for a
maintainer to promote. Seven are staged at present.

## Staged, waiting for promotion

The restamp for this repository was prepared on 27 November 2026, in a
session whose token lacked the `workflow` scope. The seven workflow
files it changes are therefore staged, and the live ones are as they
were:

| Staged | What the live file has in its place |
|---|---|
| [`workflows/release.yml`](workflows/release.yml) | `@tabnas/zon`, the package of the template this repository was made from, where it asks npm whether a version is published |
| [`workflows/clib-release.yml`](workflows/clib-release.yml) | `libtabnaszon`, as the library it builds, attaches and names in the release notes |
| [`workflows/crates-release.yml`](workflows/crates-release.yml), [`workflows/deps-gate.yml`](workflows/deps-gate.yml), [`workflows/notify-status.yml`](workflows/notify-status.yml), [`workflows/scorecard.yml`](workflows/scorecard.yml) | `tabnas/zon` in the `Target:` line, a comment: the rest of each is the same |
| [`workflows/clib.yml`](workflows/clib.yml) | nothing: there is no live `clib.yml` |

To promote them, run `rollout/apply-ci-folders.sh --apply openapi` from
admin, which copies each to `.github/workflows/` and deletes the staged
copy. By hand, it is the same two steps. Then delete this section, and
what `AGENTS.md` says of the staging, in one change.

Until then:

- **Do not dispatch `release.yml`.** The live one decides whether to
  publish, and whether a repair is safe, by the versions of another
  package.
- No `clib` job runs on a pull request. The Go job of `ci.yml` runs the
  C library's contract tests all the same, since `go/clib/` is a
  package of the module, though not under the race detector, and
  nothing builds the library.
- Admin's `scripts/verify.sh` finds five templates that differ from
  what is deployed here, and a stamp of the C library that is not
  current.

## Stamped by admin

Admin has a template for each of `crates-release.yml`, `release.yml`,
`notify-status.yml`, `scorecard.yml`, `deps-gate.yml` and `ci.yml`:
`rollout/workflows/openapi__*.yml` there. `clib.yml` and
`clib-release.yml` are stamped with `go/clib/` by admin's
`tasks/adopt-clib.sh`, from `tasks/clib-template/` and this
repository's row in `tasks/clib-rollout.tsv`, as `libtabnasopenapi`.
The staged copies above are those texts, byte for byte, and so is the
live `ci.yml`.

Do not edit any of them here alone. Change the template or the row in
admin, and bring the file here in the same reviewed pull request:
admin's `scripts/verify.sh` compares each deployed file with its
template, and fails a stamp edited by hand. `AGENTS.md` says what has to
happen before `release.yml` is dispatched for the first time.

Sessions still cannot push tags. Releases therefore go through
`workflow_dispatch`, and a workflow that runs only on a tag push needs a
maintainer to push that tag.

## Promoted

These were staged here and now run from `.github/workflows/`:

- **`ci.yml`**, the shared polyglot CI. `deps` names the siblings it
  clones and builds against their `main`: `parser`, `support`, `debug`,
  `json`, `jsonic`, `yaml` and `expr`. `expr` is there for the resolver,
  which builds on its tree layer.

- **`docs.yml`** — the prose gate: Vale over the reader-facing pages at
  the levels set in `.vale.ini`, on the file list
  `ts/scripts/gated-docs.cjs` produces. See `docs/STYLE-GUIDE.md`.

  It needs no sibling checkouts and no secrets, and pins its own Vale
  version. Errors fail the job; warnings go to the run summary as a
  report. `make prose` runs the identical check locally, and the test
  suite runs the other half of the gate (`ts/test/docs.test.js`).

- **`rust.yml`**, the Rust gate: `ci/rust/run.sh` (formatting,
  build, the shared fixtures, doctests, clippy, and a lockfile check that
  exempts only the sibling crates' versions) on the MSRV pinned in
  `rs/Cargo.toml`. It clones `tabnas/parser`, `tabnas/json`,
  `tabnas/jsonic`, `tabnas/yaml`, `tabnas/support` and `tabnas/debug`
  beside the checkout, because the committed manifest takes them as path
  dependencies, although all of them are on crates.io.
  `make test-rs` is the fast local loop; the script is what CI runs.

`clib.yml` was retired with the grammar of the template this
repository was copied from, whose C library it built. It is back as a
stamp, which is staged: see above.
