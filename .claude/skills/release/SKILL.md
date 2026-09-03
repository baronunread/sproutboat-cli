---
name: release
description: Cut a sproutboat-cli release — pick the next version from what actually changed since the last tag, update CHANGELOG.md, and tag it. Use when the user asks to release, cut a release, ship a version, tag a release, or asks what the next version number should be.
---

# Release sproutboat-cli

Tagging a `vX.Y.Z` here triggers an immediate, real `npm publish`
(`.github/workflows/release.yml`, on push of a tag matching `v*`, gated only
on the tag equalling `package.json`'s version). There is no manual approval
step in CI. **Never tag or push a tag without the user explicitly saying to
proceed after seeing the drafted version and changelog** — everything before
that point is safe to do and iterate on freely.

## 1. Orient

```bash
git status --short                          # must be clean
git branch --show-current
git fetch origin
git log --oneline -1 origin/main
```

Releases in this repo's history were always tagged on `main`, after merge.
If the current branch isn't `main` and isn't a superset of it (check with
`git merge-base --is-ancestor origin/main HEAD`), say so and ask whether to
release from the current branch anyway or wait — don't assume.

```bash
last_tag=$(git describe --tags --abbrev=0)
pkg_version=$(node -p "require('./package.json').version")
```

`package.json`'s version and the last tag are often *already* different —
this repo bumps the version in an ordinary commit mid-branch, then tags
later. If they differ, the gap between `$last_tag` and `$pkg_version` is
already-decided; your job is to check whether anything landed *since* that
bump also deserves to move the target further, not to silently re-decide it.

## 2. Gather what's unreleased

```bash
git log --reverse --pretty="%H %s" ${last_tag}..HEAD -- . ':!CHANGELOG.md'
```

Read every commit — subject and, for anything non-obvious, `git show
--stat`/body. Drop pure noise from the list before classifying: `release:
vX.Y.Z (...)` commits (meta, not content), merge commits, and anything
already summarized inside a later "release:" commit's own history.

Bucket each real commit the same way `CHANGELOG.md`'s existing entries do:

- **Added** — a new command, flag, capability, or file format support.
- **Fixed** — something that was broken now isn't. Include the user-visible
  symptom, not just the internal cause, when the commit body has one.
- **Changed** — behavior changed but nothing was strictly added or fixed
  (renamed output, different defaults, internal-only rework like a lint
  migration).
- **Performance** — same behavior, measurably faster/cheaper.
- **Removed** / **Deprecated** — a command, flag, or config field taken away
  or on its way out. Rare; treat any hit here as a signal for §3.

A commit can land in more than one bucket (a fix that's also a behavior
change). Skip nothing — an empty bucket just doesn't get a heading.

## 3. Compute version options

This repo is pre-1.0, so SemVer's "major = breaking" gets folded into minor
per SemVer's own pre-1.0 carve-out — nothing here should ever propose a
`1.0.0` or a `0.x → 1.y` jump on its own; that's a milestone decision for
the user to raise, not to infer from commits.

- Any **Removed**/**Deprecated**, or an **Added**/**Changed** entry that
  breaks a previous command/flag/config shape without a compatible fallback
  → bump the **minor**, reset patch to 0.
- Any other **Added** entry, with no breaking one → bump the **minor**.
- Only **Fixed** / **Changed** (non-breaking) / **Performance** → bump the
  **patch**.

Compute this bump against `$last_tag`. Then reconcile with `$pkg_version`:

- If the computed target is `<= $pkg_version`, the already-decided bump
  covers it — offer `$pkg_version` as the release version.
- If the computed target is `> $pkg_version` (more landed after the version
  was bumped than the bump accounted for), offer **both**: `$pkg_version`
  as-is, and the higher computed version, and say concretely what's in the
  gap between them so the choice is informed, not a guess.

Present the option(s) with `AskUserQuestion` — the version number as the
option label, the bucket counts/highlights as the description. Don't pick
for the user even when there's only one sane option; confirming a version
number before it's committed is cheap and this step is exactly where a
human should have the last word on how a bump is framed.

## 4. Draft the CHANGELOG entry

Write it in the voice of the existing entries — dated `## [X.Y.Z] — YYYY-MM-DD`
heading (today's date), the bucket headings from §2 in the same order
(`### Added`, `### Fixed`, `### Changed`, `### Performance`), one bullet per
commit or small group of related commits, written for a reader who wants to
know what changed and why it matters, not a copy of the commit subject line.
Move the current `## [Unreleased]` content into this new section rather than
duplicating it, and leave a fresh empty `## [Unreleased]` at the top.
Add the new `[X.Y.Z]: .../compare/<last_tag>...vX.Y.Z` link at the bottom in
the existing list, and repoint `[Unreleased]` to
`.../compare/vX.Y.Z...HEAD`.

Show the drafted section to the user as a normal message before touching any
file — changelog wording is worth a read, not a rubber stamp, and this is
the natural point for them to fix a bullet or fold two together.

## 5. Apply, once the draft is approved

```bash
# package.json version, if it isn't already at the target
# CHANGELOG.md, with the approved section
bun run surface        # regenerates SURFACE.md against the new version banner
bun run typecheck
bun run lint
bun test
```

All three checks must pass — this is the commit CI will run again on tag
push, and CI only re-runs typecheck + test, not lint, so catching a lint
break here is the only place it gets caught before it's public.

```bash
git add package.json CHANGELOG.md SURFACE.md
git commit -m "release: vX.Y.Z (<one-line summary, same style as history>)"
```

Look at `git log --oneline --grep='^release:'` for the exact phrasing
convention (`release: v0.4.7 (deploy auto-provisions id-less storage bindings)`
etc.) before writing the summary.

## 6. Stop

Report the commit, and ask explicitly: tag and push now (fires the real
`npm publish`), or hold this commit for later. Do not proceed past this
point without an explicit yes in this turn — a prior "go ahead" on the
version or the changelog draft does not cover this step.

## 7. Tag, publish, and record the release

Only after explicit confirmation:

```bash
git push origin <branch>
git tag vX.Y.Z
git push origin vX.Y.Z
```

Pushing the tag is what fires `release.yml`. Check it:

```bash
gh run list --repo baronunread/sproutboat-cli --workflow=release.yml --limit 1
```

Once that run succeeds (poll if needed — don't declare success before it
reports `completed`/`success`), create the GitHub Release so the tag has
notes attached (today, none of the 14 existing tags do):

```bash
gh release create vX.Y.Z --repo baronunread/sproutboat-cli \
  --title "vX.Y.Z" --notes-file <(sed -n '/^## \[X.Y.Z\]/,/^## \[/p' CHANGELOG.md | sed '$d')
```

(Extract just that version's section between its heading and the next
`## [` — don't hand the whole file to `--notes-file`.)

If the workflow run fails, stop and report it rather than retrying blindly —
a failed publish after a real tag push needs the user's judgment on whether
to fix-forward with a new patch version or investigate the tag itself.
