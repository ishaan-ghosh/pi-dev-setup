# Audit profile schema v1

Audit profiles are human-editable YAML files. The v1 workflow treats this schema as a documented convention, not a strict validation contract. Keep profiles portable and reviewable. Repo-local profiles override generic built-in `commit` and `pr` defaults bundled with the audit-flow skill.

```yaml
name: pr
description: Full PR audit
type: pr # pr | stack | commit | platform

# Required for PR/stack profiles unless every repos[] entry supplies both.
# CLI --base/--head override these.
base: origin/main
head: HEAD

# Prompt fragments are resolved relative to the selected config root. The
# preferred repo root is `.audit/`; `.pi/audit/` is a legacy fallback.
fragments:
  - prompts/base.md
  - prompts/repo-context.md
  - prompts/output-format.md

# Optional. Use for multi-repo audits where all repos are part of one product/platform.
platform:
  name: RoboEval
  context_root: ${ROBOEVAL_ROOT:-..}
  source_of_truth:
    - AGENTS.md
    - merge_context.md

# Optional for single-repo audits, expected for platform audits. Paths should be
# relative to `platform.context_root` when possible.
repos:
  - name: backend
    role: api-worker-sandbox
    path: backend
    base: origin/main
    head: HEAD
  - name: frontend
    role: web-ui
    path: RoboEval-frontend

# Optional. Defaults to `.audit/local/audits` when the repo has `.audit/`,
# otherwise to legacy `.pi/local/audits`.
artifact_root:
  repo: backend
  path: .audit/local/audits

# Optional suggested validation commands. Auditors should run targeted validation
# when useful and state what was or was not verified.
validation:
  commands:
    - name: tests
      command: uv run pytest -q
```

## Path resolution

Tracked profiles should prefer relative paths and environment-variable placeholders. Machine-specific overrides belong in gitignored `.audit/local/audit.overrides.yaml`. Legacy `.pi/local/audit.overrides.yaml` remains a fallback when the neutral override is absent.

After environment expansion, fragments selected through repository-neutral, repository-legacy, or bundled-default profile discovery must remain canonically inside the selected audit config root. Absolute paths, parent traversal, and symbolic-link escapes fail closed. A direct `--profile` path or explicit `--audit-config-root` is a caller opt-in to external fragment paths; symbolic-link path components are still rejected.

Profile resolution order:

1. Direct `--profile <path>`
2. Explicit `--audit-config-root <path>`
3. `.audit/profiles/<name>.yaml`
4. `.pi/audit/profiles/<name>.yaml`
5. Built-in `commit` or `pr` profile

Value resolution order:

1. Explicit CLI argument
2. `.audit/local/audit.overrides.yaml`
3. `.pi/local/audit.overrides.yaml`
4. Environment variable
5. Tracked profile default
6. Current repo-relative path

Target-ref resolution for each repository:

1. `repos[].base` / `repos[].head`
2. CLI `--base` / `--head`
3. Top-level profile `base` / `head`
4. `HEAD` for non-PR profiles only

For effective `type: pr` or `type: stack` profiles (including a profile named `stack` with no explicit type), every repository must receive explicit nonempty base and head values through the first three sources. The helper rejects omitted refs and refs that resolve to the same commit. The built-in PR profile therefore requires `--base` and `--head`; a descriptive target such as `PR #14` never resolves refs implicitly.

Artifact-root resolution order:

1. `--artifact-root <path>`
2. Profile `artifact_root`
3. `.audit/local/audits` when the repository has `.audit/`
4. `.pi/local/audits` when the repository has no neutral `.audit/` root

## Notes

- Do not use platform profiles to casually span unrelated platforms. Multi-repo platform audits are for repositories that make up one product/platform.
- `audit.yml` records the selected profile/config, override, and artifact-root provenance without including override contents.
- Every configured repo must resolve to a distinct Git root with non-unborn base/head commits. The helper captures repos in profile order so multi-repo aggregate snapshots are deterministic.
- Submodule gitlinks are unsupported in a repository snapshot. Select each required submodule as its own `repos[]` entry so its raw tracked worktree is bound independently.
- Artifact paths inside a selected Git repository must be ignored; there is no safety override because generated files would invalidate the immutable target. The complete audit directory itself must be ignored so later verifier artifacts cannot escape selective file rules. Before creating it, the helper also checks every planned standard artifact plus unpredictable focused-verification candidates, then revalidates the target after writing startup artifacts. It rejects symbolic-link path components, invalid multi-component audit IDs, and existing audit-ID directories.
- The supported YAML subset rejects the reserved mapping keys `__proto__`, `prototype`, and `constructor` at every nesting level. `record-stage.mjs` also rejects them as reviewer keys before writing metadata.
- Avoid copying full historical prompts into profiles. Prefer small reusable prompt fragments.
- Repository-controlled fragments are included in primary and final-diff prompts but omitted from the blind peer prompt. Only fragments bundled with the installed audit-flow package may be included in the peer prompt, and private artifact references in those fragments fail closed.
- Future extensions may validate this schema after the workflow stabilizes.
