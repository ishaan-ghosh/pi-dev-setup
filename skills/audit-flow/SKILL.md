---
name: audit-flow
description: Orchestrate human-in-the-loop code and PR audits with repo-local prompt profiles, isolated reviewer sessions, cross-model peer review artifacts, and final fix or GitHub review handoff. Use before committing, pushing, merging, or submitting PR review feedback.
---

# Audit Flow

Use this skill to run explicit, human-approved audits before commits, pushes, merges, or PR review feedback.

## Core model

- Use a parent orchestrator plus separate reviewer sessions.
- The parent Pi session is the audit cockpit: select the target, compose the profile, manage artifacts, synthesize reviewer outputs, support interactive human drill-down, and record final accepted findings.
- Dispatch reviewer sessions separately and require them to inspect the target directly. The helper records structural provenance for those dispatches, but it does not prove isolation or authorship. Reviewers may write audit artifacts and run validation, but they must not edit application code.
- Fixing is a separate pass after human acceptance of findings, handled by a writer/worker session scoped to accepted findings only.
- The live, resumable audit session is the canonical human approval checkpoint. Files are durable receipts and handoff artifacts generated from the live discussion.

## Repo conventions

See `PROFILE-SCHEMA.md` for the profile convention, `FINDINGS-SCHEMA.md` for structured finding/status fields, and `AUDIT-METADATA.md` for `audit.yml`. The helpers strictly validate target identity, artifact provenance, reviewer gates, and finalization; they validate only the documented safety subset of the broader human-editable profile and findings schemas.

Tracked, harness-neutral repo-specific audit inputs live under:

```txt
.audit/
  profiles/*.yaml
  prompts/*.md
```

The helper prefers `.audit/`, falls back to the legacy Pi-specific `.pi/audit/` layout, and finally falls back to generic built-in `commit` and `pr` profiles bundled with this skill. An explicit profile or `--audit-config-root` takes precedence over repo discovery.

After environment expansion, fragments from discovered neutral, legacy, or bundled profiles must remain inside their selected config root. Direct profiles and explicit config roots are the caller's opt-in to external fragments. Symbolic-link path components always fail closed. The supported YAML subset also rejects `__proto__`, `prototype`, and `constructor` mapping keys recursively, and stage recording rejects those names as reviewer keys.

Prompt/profile changes that are generally useful for a repo should go through normal review and be committed. One-off, secret, machine-specific, or experimental prompt changes belong under `.audit/local/audit-experiments/`. Legacy repositories may continue using `.pi/local/audit-experiments/`. Audit artifacts should record the tracked profile/fragments and the exact local override path used.

Generated/private artifacts live under gitignored:

```txt
.audit/local/audits/<audit-id>/
```

The helper refuses to write artifacts inside a git repository unless the complete audit directory itself is ignored; it also checks every planned standard artifact and unpredictable focused-verification candidates as defense in depth. Prefer adding `.audit/local/` to `.gitignore` or `.git/info/exclude`. Legacy repositories may keep `.pi/local/` ignored. An unignored artifact directory cannot be exempted because generated reports would change the bound target snapshot. Startup revalidates the target after writing the initial metadata and prompts.

Do not commit `.audit/local/` or legacy `.pi/local/` artifacts unless the human explicitly requests moving distilled context into tracked docs.

Do not alias audit roots with symbolic links. The helper rejects symbolic-link components in artifact paths and refuses to reuse an existing audit ID, preventing cross-harness redirects and accidental overwrites.

## Immutable target snapshot

`start-audit.mjs` requires every selected target to be a Git repository with resolvable base and head commits. For one repository it uses the project Git root. For platform audits it preserves profile `repos` order and resolves each `repos[].path` under `platform.context_root`. Commit profiles use ref precedence `repos[].base/head`, CLI `--base/--head`, top-level profile `base/head`, then `HEAD`. PR/stack profiles require explicit base and head refs for every repo and reject equal resolved OIDs.

For every repository, `audit.yml` binds the resolved base/head OIDs, binary/full-index diff digests, and ordered tracked and untracked manifests. Every tracked entry records its stage-0 index mode/OID plus raw worktree bytes and normalized mode, bypassing filters and Git index cache flags. Final symlinks hash link text; parent-component symlinks fail closed. Missing tracked paths are recorded explicitly. Unmerged entries, special files, and submodule gitlinks fail closed; audit a submodule as a separate selected repo. Generated prompts disclose the snapshot schema, aggregate digest, and an ordered compact canonical JSON record containing each repo's capture inputs (including role) and resolved digest/count fields; reviewers reconstruct the raw manifests from the named repositories. `record-stage.mjs` re-captures the snapshot before every stage update. Any drift requires a new audit.

Prompts and reports also carry SHA-256 digests. Primary, peer, and final-diff reports are immutable after their first successful record. Each recorded stage requires nonempty tool, model, and session identity; dispatch and session IDs must be unique. Focused verification requires structurally completed primary and peer stages and cannot predate either; equal timestamps are accepted. Finalization independently checks valid nondecreasing primary, peer, and final-diff timestamps, rejects supplemental verification timestamps earlier than peer, and binds every fixed or supplemental prompt and report path to dispatched artifact metadata. The recorder writes an unsigned `orchestrator-attested` binding to the audit, reviewer key, dispatch, target, prompt, report, artifact, and timestamp. This is structural local bookkeeping, not cryptographic proof of execution identity, authorship, blindness, direct inspection, independence, or reviewer cognition.

## Privacy and secrets

Treat audit artifacts as local/private by default. Do not put secrets, tokens, private endpoints, raw payloads, customer data, or sensitive logs into tracked prompts, PR notes, review comments, or receipts. Receipts should summarize validation without sensitive output. If sensitive evidence is necessary for a finding, keep it in local artifacts and say that sensitive evidence was reviewed locally.

## Audit types

- Commit Audit: review a local diff unit before it becomes committed or pushed history, such as unstaged changes, staged changes, or a commit/range.
- PR Audit: review a pull request as the reviewable integration unit, including full diff against base, PR claims, affected contracts/tests/docs, and stacked-PR context when relevant.
- Multi-repo Platform Audit: review multiple repositories that are parts of the same product/platform, such as a backend repo and frontend repo for one platform. Keep this lightweight: one platform context root, named member repo roots/roles, and required first steps are enough for v1. Do not broaden an audit across unrelated platforms unless the human explicitly scopes that unusual case.

Profiles are human-editable. Tracked profiles should prefer portable relative paths and environment-variable placeholders. Machine-specific path overrides belong in gitignored `.audit/local/audit.overrides.yaml`, not tracked prompt/profile files. The helper falls back to legacy `.pi/local/audit.overrides.yaml` only when no neutral override exists. Explicit CLI paths take precedence over profile paths; profile artifact roots take precedence over the neutral or legacy default.

For v1, audit coverage applies to the diff entering the branch rather than to every final commit object. It is acceptable to amend, squash, or reorder commits after a local audit as long as meaningful resulting changes are re-audited before push or PR review. Before pushing or opening a PR, audit the outgoing branch or PR as a whole.

PR audits should understand stacked branches. Use the PR base branch as the default comparison base for the current review unit, not `main`, unless explicitly requested. Separate inherited parent findings, child-specific findings, and merge-order/base-update risks. Re-fetch and record observed base/head refs when reviewing remote PRs.

Both audit types use the same lifecycle:

```txt
candidate finding → independently verified finding → human accepted/rejected → fix, review comment, or defer
```

## Two-agent finding verification gate

Every finding must be verified by at least two independent reviewer agents before it enters synthesis, human review, final findings, a fix plan, or a GitHub review packet. Treat "verified" as direct re-inspection of the target and cited evidence, not just agreement with another reviewer’s prose.

Primary+peer confirmation satisfies the policy gate only after the peer's raw-target report is recorded. Repository-controlled fragments are omitted from the peer prompt so they cannot direct it to private artifacts; this does not prove what the peer saw outside the helper. Compare the reports afterward. Any one-reviewer or disputed finding requires a fresh focused reviewer with separate nonempty `verification-<name>-prompt.md` and `verification-<name>.md` artifacts. Record both with nonempty tool/model/session identity. One-source allegations stay outside terminal `findings.json` as residual questions.

## Separate final-diff gate

Finding verification does not review the final diff as a shipping unit. After primary and peer are recorded, every completed audit requires a separate `final-diff-reviewer` dispatch using `final-diff-reviewer-prompt.md`, saved as `final-diff-review.md`, and recorded with `--stage final-diff`. This reviewer adversarially inspects the complete immutable target for incorrect fixes, integration regressions, missing tests, and issues outside earlier finding scopes. A `finding-verifier` report cannot satisfy this gate. If fixes change the target, start a new audit at the new final snapshot.

Before synthesis, the parent orchestrator must compare reviewer artifacts, list every candidate finding with the roles that verified it, launch verifier agents for one-agent findings, and only synthesize findings with at least two verifier roles.

## Validation command policy

Audit agents may run safe, targeted read-only or validation commands automatically when they materially improve confidence. Examples include `git status`, `git diff`, `gh pr view`, targeted tests, linters, typechecks, config/schema checks, and read-only migration graph inspection.

Require explicit human approval before expensive, stateful, hardware, network-mutating, or destructive commands. Examples include physical robot runs, database/service mutation, Docker compose lifecycle commands unless pre-approved by the profile/session, posting GitHub comments, committing, pushing, long Isaac/GPU runs, commands touching secrets, and external production-system operations.

## V1 cross-model validation

Use generic role values in reviewer metadata and canonical artifact names. Use concrete reviewer keys (`primary`, `peer`, `final_diff`, or a supplemental key) in `finding.source`. Record actual model/tool/session values in `audit.yml`.

Use semi-automated peer-review handoff in v1:

1. Pi produces the initial audit and a blind raw-target peer prompt.
2. The human explicitly launches or approves the independent peer reviewer without sharing primary output.
3. The human or a later helper writes peer raw-target output into the audit artifact directory and records it.
4. Only then does Pi compare/synthesize primary and peer reports; any later critique uses separate artifacts.

Do not assume fully automated tmux control is available.

One parent/orchestrator owns each audit directory. A peer or verifier running in another harness contributes to that same directory; it must not start a duplicate audit for the same review unit.

## Suggested artifact set

```txt
.audit/local/audits/<audit-id>/
  audit.yml
  primary-reviewer-prompt.md
  primary-initial.md
  primary-findings.json
  peer-review-prompt.md
  peer-review.md
  final-diff-reviewer-prompt.md
  final-diff-review.md
  verification-*.md
  synthesis.md
  final-human-reviewed.md
  findings.json
  final-plan.md
  receipt.md
```

Use Markdown for human review and JSON/YAML for later automation.

## Minimal v1 helpers

Use `scripts/start-audit.mjs` to compose a tracked profile, capture the immutable target, create the local artifact directory, write `audit.yml`, and write primary, blind-peer, and final-diff prompts.

Resolve the script path relative to this skill directory. Example from a repository root:

```bash
node <audit-flow-skill-dir>/scripts/start-audit.mjs --profile pr --target "PR #14" --base origin/main --head HEAD
node <audit-flow-skill-dir>/scripts/start-audit.mjs diff
node <audit-flow-skill-dir>/scripts/start-audit.mjs staged
node <audit-flow-skill-dir>/scripts/start-audit.mjs pr "PR #14" --base origin/main --head HEAD
```

The helper prints JSON containing `auditDir`, `auditYmlPath`, `primaryPromptPath`, `primaryInitialPath`, `peerPromptPath`, `finalDiffPromptPath`, and related artifact paths. Common positional commands map to profiles: `diff`, `staged`, and `commit` use the `commit` profile; `pr` and `stack` use the `pr` profile.

Use `scripts/record-stage.mjs` after a reviewer artifact has been written to record completion metadata in `audit.yml`:

```bash
node <audit-flow-skill-dir>/scripts/record-stage.mjs --audit-yml <auditYmlPath> --stage primary --artifact <primaryInitialPath> --tool pi-subagent --model <model> --session-id <id>
node <audit-flow-skill-dir>/scripts/record-stage.mjs --audit-yml <auditYmlPath> --stage peer --artifact <peerReviewPath> --tool external-peer --model <model> --session-id <id>
node <audit-flow-skill-dir>/scripts/record-stage.mjs --audit-yml <auditYmlPath> --stage final-diff --artifact <finalDiffReviewPath> --tool pi-subagent --model <model> --session-id <id>
node <audit-flow-skill-dir>/scripts/record-stage.mjs --audit-yml <auditYmlPath> --stage verification --reviewer-key <key> --prompt verification-<name>-prompt.md --artifact verification-<name>.md --tool <tool> --model <model> --session-id <id>
```

After `findings.json` and `receipt.md` are complete, strict finalization revalidates the unchanged target, required prompt/report digests and identities, structural attestations, copied-report defenses, the exhaustive status enum, and concrete reviewer-key/artifact bindings for every finding:

```bash
node <audit-flow-skill-dir>/scripts/finalize-audit.mjs --audit-yml <auditYmlPath> --status passed
```

Valid final statuses are `passed`, `passed_with_deferred`, and `blocked`. Findings and receipt paths come only from `audit.yml`; they cannot be substituted at finalization.

## Primary reviewer automation

When the subagent tool is available, do not stop after generating prompts. Launch the primary reviewer automatically:

1. Run `start-audit.mjs` for the requested profile/target.
2. Launch a fresh `reviewer` subagent using `primary-reviewer-prompt.md` as the task contract, with `cwd` set to the audited repo root, `output` set to `primaryInitialPath`, and `outputMode` set to `file-only` for large reports.
3. The reviewer must not edit application code.
4. After the reviewer finishes, run `record-stage.mjs` with the primary artifact and the actual nonempty `--tool`, `--model`, and `--session-id`. Do not fabricate unavailable identity; leave the stage unrecorded until it is available.
5. Tell the human where `primary-initial.md` and the blind `peer-review-prompt.md` were written, and pause for the semi-automated peer-review step. Do not share primary output with the peer before `peer-review.md` is recorded.

If the subagent tool is unavailable, perform the primary review in the parent session, write the result to `primary-initial.md`, then record it with `--tool pi-parent`, the actual model identifier, and the parent session identifier.

## Orchestration outline

1. Read repo instructions: `AGENTS.md`, `CONTEXT.md`, `CONTRIBUTING.md`, and `docs/adr/*.md` when present.
2. Identify audit type, target, base/head refs, and current git cleanliness constraints.
3. Run the minimal v1 start helper for the selected profile and target.
4. Launch the primary reviewer automatically and save its report to `primary-initial.md`.
5. Run `record-stage.mjs` with the primary artifact and actual tool/model/session identity to update `audit.yml`.
6. Pause for or ingest the blind raw-target peer output into `peer-review.md`, then record the peer stage before comparing it with primary output.
7. Apply the two-agent finding verification gate: compare reviewer artifacts, identify findings with fewer than two concrete reviewer keys, launch fresh focused verifier agents as needed, bind each verifier prompt/report, and exclude one-source allegations from terminal findings.
8. Synthesize disagreements and candidate findings that passed the two-agent gate.
9. Keep the parent session live for human drill-down.
10. After human confirmation, write final accepted/rejected/deferred findings and a fix or PR-review plan.
11. Only then run a fixing agent or generate GitHub review comments.
12. After fixes, run targeted verification and re-audit the changed lines or accepted-finding area before committing/pushing.
13. Launch and record the separate final-diff adversarial reviewer. If the target changed, start a new audit rather than reusing the old snapshot.
14. Mark every accepted finding as `fixed`, `partially_fixed`, `still_open`, or `verified` before closing the audit.
15. Produce a compact `receipt.md` suitable for PR notes without exposing raw local transcripts, then run strict finalization.

## Audit receipt

A completed audit should write `receipt.md` under the audit artifact directory. Include audit type and target, profile/fragments used, all reviewer tool/model/session values, whether peer review was included, human accepted/rejected/deferred counts, fixes or review comments generated, validation commands/results, residual risks, and final status: `passed`, `passed_with_deferred`, or `blocked`.

## Review/fix separation

Reviewer sessions are read-only with respect to application code. They may create audit artifacts under the audit directory selected by the helper (normally `.audit/local/audits/`, with `.pi/local/audits/` retained for legacy repositories) and run validation commands, but must not modify source, tests, docs, configs, migrations, or generated committed assets. A separate fix pass may edit code only after the human accepts findings and approves the fix scope. For local work, offer both a generated `fix-prompt.md` and an orchestrated fix pass; default to launching a separate Pi `worker` in the same audit session after the human approves the final fix plan. The worker must fix only accepted findings, ignore rejected/deferred findings, run targeted validation, and return a summary/diff for post-fix verification. After a fix pass, show the resulting diff, verify each accepted finding is addressed or explicitly still open, run targeted validation unless impossible, and update statuses before producing the final receipt. For coworker PRs, generate review comments from accepted findings instead of fixing unless the human explicitly asks to make changes on a branch.

## GitHub PR review comment policy

Post only human-accepted findings. Accepted confirmed findings with exact diff anchors become inline GitHub review comments. Accepted PR-level findings without stable line anchors go in the review body. Open questions are posted only when the human explicitly approves asking them. Optional suggestions are not posted by default. Rejected findings are never posted. Deferred findings usually become local follow-up issues or notes rather than PR comments unless they directly affect the reviewed PR.

In v1, Pi prepares a GitHub review packet instead of directly posting externally visible comments. The packet may include `github-review-packet.md`, `github-review-comments.json`, and `peer-github-review-prompt.md` under the audit artifact directory. The human reviews the packet, then an approved peer agent or the human posts it with `gh`. Direct Pi posting can be added later after comment anchoring and approval UX are proven.

## Output standards

Findings first, ordered by severity. Confirmed findings need exact file/line references, impact, evidence, concrete reviewer keys, and their exact artifacts. Separate confirmed findings, open questions/assumptions, optional suggestions, and residual validation gaps. Do not present a one-agent finding as confirmed or put it in terminal `findings.json`.
