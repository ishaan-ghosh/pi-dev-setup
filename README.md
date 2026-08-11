# pi-dev-setup

Shared Pi coding-agent setup for my machines and coworkers.

This repository is a Pi package. It can bundle:

- `extensions/` — TypeScript/JavaScript Pi extensions
- `skills/` — Agent Skills
- `prompts/` — slash-command prompt templates
- `themes/` — TUI themes

Current contents:

- `extensions/read-policy.ts` — nudges agents toward `grep`/`find`/`ls` first and paginated `read` calls by default.
- `skills/audit-flow` — human-in-the-loop commit/PR/platform audit workflow with repo-local prompt profiles, automated primary reviewer handoff, and local artifact receipts.
- `prompts/audit.md` — slash-command prompt template for starting the audit flow.
- Vendored skills:
  - `grill-with-docs`
  - `diagnose`
  - `improve-codebase-architecture`
  - `tdd`
  - `to-prd`
- `settings.example.json` — non-secret global settings template matching my current setup.

The vendored skills come from [`mattpocock/skills`](https://github.com/mattpocock/skills); see [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

## Repo audit layout

`audit-flow` prefers a harness-neutral repository layout so Pi, Claude Code, Codex, or another reviewer can contribute to one audit without copying artifacts:

```text
.audit/
  profiles/*.yaml
  prompts/*.md
  local/
    audits/<audit-id>/
    audit.overrides.yaml
    audit-experiments/
```

Track profiles and prompt fragments; ignore `.audit/local/`. One parent/orchestrator owns each audit directory, while peer and verifier harnesses write their role-specific artifacts into that same directory. Do not mirror an audit into multiple harness-local trees or connect artifact roots with symbolic links.

Existing repositories remain compatible. When `.audit/` is absent, the helper falls back to `.pi/audit/`, `.pi/local/audit.overrides.yaml`, and `.pi/local/audits/`. Explicit CLI paths take precedence over profile paths, and profile artifact roots take precedence over the discovered default. After environment expansion, repository-discovered and bundled profile fragments must remain inside their config root; direct profiles and explicit config roots are the caller's opt-in to external fragments. Reserved YAML mapping keys that can alter object lookup semantics are rejected recursively.

Each audit binds exact base/head commit OIDs and ordered tracked/untracked manifests. Tracked entries include index mode/OID plus raw worktree bytes and mode, so filters and assume-unchanged/skip-worktree flags cannot hide drift. Parent symlinks, unmerged entries, special files, and submodule gitlinks fail closed. PR/stack audits require explicit distinct base/head commits. Startup requires the complete audit directory to be ignored, checks the actual planned artifact set plus unpredictable verification candidates, and revalidates the target after writing. Reviewer records require nonempty prompt/report artifacts and tool/model/session identity; reserved YAML keys cannot be used as reviewer keys, and finalization binds both paths to dispatched artifact metadata and enforces reviewer chronology. Terminal findings cite concrete reviewer keys and exact artifacts. These are structural local checks, not cryptographic proof of reviewer authorship, independence, blindness, or cognition.

## Install

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.84.1
pi install git:https://github.com/ishaan-ghosh/pi-dev-setup@EXACT_REVIEWED_COMMIT_SHA
```

Then authenticate locally:

```text
/login
```

Or configure provider credentials with environment variables or your secret manager.

## Full machine bootstrap

```bash
git clone --branch v0.2.0 --depth 1 https://github.com/ishaan-ghosh/pi-dev-setup.git
cd pi-dev-setup
./scripts/bootstrap.sh
```

The bootstrap is intentionally fail-closed until `v0.2.0` is published. Before any global install, directory creation, settings copy, backup, or package install, it resolves that tag to an exact commit, validates release content, rewrites the package source to that commit, and classifies existing settings, checkout, backup, and duplicate-extension state. Existing self-package locators are normalized across supported HTTPS, `ssh://`, and scp-style Git forms before family matching. An existing exact self-package may be a string or source-only object; explicit `extensions`, `skills`, `prompts`, or `themes` filters must exactly match the reviewed release entry. It installs and persists only the resolved commit, with npm lifecycle scripts disabled, then rejects Git index cache flags and compares every tracked index entry, raw file byte, executable mode, filesystem type, and symlink target with the resolved commit. It separately rejects every untracked path, including paths hidden by repository or user Git excludes, except an untracked top-level `package-lock.json`. On failure it restores settings and moves into `.bootstrap-quarantine/` only the checkout path found absent at both preflight and the immediate pre-install check. This protects pre-existing paths and cooperative concurrent changes; it is not a lock against a hostile same-user process racing after the final check. A retry can proceed without deleting the preserved partial checkout.

## Settings template

Use `settings.example.json` as reviewed input to the bootstrap. Its self-package entry names the release tag because a release file cannot contain its own commit hash; bootstrap resolves and replaces that locator before writing user settings. Do not copy the template unchanged if exact-commit pinning is required. For manual setup, replace the tag with the reviewed commit SHA before copying:

```bash
sed 's/@v0\.2\.0/@EXACT_REVIEWED_COMMIT_SHA/' settings.example.json > /tmp/pi-settings.review.json
```

Review `settings.example.json` first. It includes model preferences and packages I use:

- `npm:pi-subagents`
- `npm:pi-mcp-adapter`
- `npm:context-mode` with its skills filtered to context-mode-only skills, avoiding duplicate vendored engineering skills
- `git:https://github.com/hasit/pi-community-themes`
- optional additional skills from `git:https://github.com/mattpocock/skills.git` that are not vendored here

`enabledModels` is intentionally not set in the template because scoped model patterns can warn before you authenticate with `/login`. Configure model cycling per machine with `/scoped-models` after login.

## Test

```bash
npm test
```

The tests use isolated command stubs; they do not install Pi or touch your user settings.

## Update

Pi and this package are intentionally pinned. To upgrade, review the new Pi
release and package tag, update the exact versions in this repository, and
explicitly replace the old pinned source:

```bash
pi remove git:https://github.com/ishaan-ghosh/pi-dev-setup@OLD_EXACT_COMMIT_SHA
pi install git:https://github.com/ishaan-ghosh/pi-dev-setup@NEW_EXACT_REVIEWED_COMMIT_SHA --no-approve
```

The remove step deletes the old installed package checkout, so preserve local
changes and approve it deliberately. Do not use bare `pi update` for this
setup: it updates Pi itself independently of the reviewed package contract.

If Pi is already running, reload resources:

```text
/reload
```

## Secrets policy

Do not commit:

- `~/.pi/agent/auth.json`
- sessions
- installed package clones/dependencies
- literal API keys in `settings.json` or `models.json`

Use `/login`, environment variables, or secret-manager commands instead.

## Troubleshooting

### Skill conflict warnings involving `context-mode`

`context-mode` versions after `1.0.107` bundle several upstream skills, including `diagnose`, `grill-with-docs`, `improve-codebase-architecture`, and `tdd`. This package vendors those skills directly, so `settings.example.json` filters `context-mode` to only its own skills. If you created settings from an older version of this repo, update the `npm:context-mode` package entry to the object form used in `settings.example.json`.

### `No models match pattern ...`

This usually means scoped model cycling was configured before the provider was authenticated, or Pi's model registry is older than the model names in your settings. Run `/login`, then configure cycling with `/scoped-models`. If needed, reinstall the supported Pi version:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.84.1
```
