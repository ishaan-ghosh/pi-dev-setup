# Audit metadata v1

`audit.yml` is the canonical place to record audit target metadata, profile composition, actual tools/models, and structural session provenance. Findings cite concrete reviewer keys such as `primary`, `peer`, or `verifier_peer_only`; role names and tool/model names are not finding-source identifiers.

Example:

```yaml
id: 2026-05-07-pr-14-smolvla
type: pr
status: in_progress # in_progress | passed | passed_with_deferred | blocked
created_at: 2026-05-07T12:00:00Z
updated_at: 2026-05-07T12:30:00Z

target:
  raw: PR 14
  snapshot_schema: git-worktree-v2
  snapshot_sha256: 9a2d...e410
  repos:
    -
      name: deployment-harness
      role: deployment
      root: /work/RoboCortex/deployment-harness
      base_ref: origin/main
      base_oid: abc123...
      head_ref: HEAD
      head_oid: def456...
      staged_diff_sha256: 4f91...812c
      unstaged_diff_sha256: e3b0...b855
      tracked_manifest_sha256: 91bc...33d0
      tracked:
        -
          path: scripts/check.sh
          index_mode: "100755"
          index_oid: 82ad...a771
          worktree_mode: "100755"
          sha256: 1ac4...de20
      untracked_manifest_sha256: 8b72...c390
      untracked:
        -
          path: scripts/new-check.sh
          mode: "100755"
          sha256: 1ac4...de20
      snapshot_sha256: f7c1...0ab2

profile:
  name: pr
  path: .audit/profiles/pr.yaml
  source: repo-neutral
  config_root: .audit
  fragments:
    - prompts/base.md
    - prompts/repo-context.md
    - prompts/pr-github-worktree.md
    - prompts/validation-policy.md
    - prompts/output-format.md
  peer_fragments: []
  local_overrides:
    - .audit/local/audit.overrides.yaml
  local_override_source: neutral

reviewers:
  primary:
    role: primary-reviewer
    dispatch_id: 90dc799c-8857-4f09-8e16-cc7c0ae2fd14
    tool: pi
    model: openai/example
    session_id: pi-session-id
    prompt: primary-reviewer-prompt.md
    prompt_sha256: 168a...e211
    artifact: primary-initial.md
    report_sha256: 24cf...9ab0
    completed_at: 2026-05-07T12:10:00Z
    attestation:
      kind: orchestrator-attested
      audit_id: 2026-05-07-pr-14-smolvla
      reviewer_key: primary
      dispatch_id: 90dc799c-8857-4f09-8e16-cc7c0ae2fd14
      target_snapshot_sha256: 9a2d...e410
      prompt_sha256: 168a...e211
      artifact: primary-initial.md
      report_sha256: 24cf...9ab0
      recorded_at: 2026-05-07T12:10:00Z
  peer:
    role: peer-reviewer
    dispatch_id: 8c1cbf86-207d-411f-bce1-7335314e21b4
    tool: external-peer-agent
    model: example-model
    session_id: peer-session-id
    prompt: peer-review-prompt.md
    prompt_sha256: a037...51cc
    artifact: peer-review.md
    report_sha256: null
    completed_at: null
  final_diff:
    role: final-diff-reviewer
    dispatch_id: b3b1883e-6b10-47fa-aee4-b48491e28e04
    tool: final-review-tool
    model: example-model
    session_id: final-session-id
    prompt: final-diff-reviewer-prompt.md
    prompt_sha256: f1db...0a19
    artifact: final-diff-review.md
    report_sha256: null
    completed_at: null
  verifier_peer_only:
    role: finding-verifier
    dispatch_id: 32c04cbf-2121-4ea8-86be-839d0f86022b
    tool: pi-subagent
    model: example-model
    session_id: verifier-session-id
    prompt: verification-peer-only-prompt.md
    prompt_sha256: 2cc1...de30
    artifact: verification-peer-only.md
    scope: peer-only findings requiring second-agent verification
    completed_at: null

validation:
  - command: uv run pytest -q
    result: passed
    summary: 39 passed

artifacts:
  root: .audit/local/audits/2026-05-07-pr-14-smolvla
  root_source: neutral-default
  primary_prompt: primary-reviewer-prompt.md
  primary_initial: primary-initial.md
  peer_review_prompt: peer-review-prompt.md
  peer_review: peer-review.md
  final_diff_prompt: final-diff-reviewer-prompt.md
  final_diff_review: final-diff-review.md
  verification_peer_only: verification-peer-only.md
  verification_peer_only_prompt: verification-peer-only-prompt.md
  findings: findings.json
  receipt: receipt.md

finalized_at: null
finalization: null
```

Keep this file local/private by default under `.audit/local/audits/<audit-id>/`. Legacy-only repositories may use `.pi/local/audits/<audit-id>/` while migrating.

The profile `source` is one of `direct`, `explicit-config-root`, `repo-neutral`, `repo-legacy`, or `default`. `local_override_source` is `neutral`, `legacy`, or `null`. Artifact `root_source` records `cli`, `profile`, `neutral-default`, or `legacy-fallback`. These provenance fields make path selection auditable without exposing override contents.

All helper-parsed YAML, including profiles, overrides, and `audit.yml`, rejects the reserved mapping keys `__proto__`, `prototype`, and `constructor` recursively; stage recording rejects the same names as reviewer keys before writing metadata. Startup requires the complete audit directory itself to be ignored, validates every planned standard artifact and unpredictable focused-verification candidates as defense in depth, and revalidates the target after writing the initial metadata and prompts.

## Target snapshot and digests

Every selected repository is mandatory and Git-backed. Single-repo audits use the project Git root; multi-repo audits preserve profile `repos` order. Commit profiles use repo, CLI, profile, then `HEAD` ref precedence. PR/stack profiles have no `HEAD` fallback: every repo requires explicit base and head refs, and the resolved OIDs must differ. `base_oid` and `head_oid` bind the resolved commits.

`git-worktree-v2` retains binary/full-index staged and unstaged diff digests and additionally enumerates every stage-0 tracked index path. Each tracked entry binds its index mode/OID plus the raw worktree bytes and normalized mode independently of Git diff filtering and index cache flags. Regular files hash bytes read from the filesystem. A final symlink hashes its link text and uses `120000`; a missing tracked path uses `worktree_mode: missing` and `sha256: null`. Symlinks in parent path components and other filesystem kinds fail closed. Unmerged index entries fail closed. Gitlinks (`160000`) and submodules are intentionally unsupported; select each submodule as a separate audit repository instead. The untracked manifest uses the same raw pathname ordering and raw regular-file/symlink handling. All digest fields are lowercase 64-character hex strings. Snapshot canonical JSON recursively sorts object keys, preserves array order, and contains no whitespace.

Stage recording revalidates the complete aggregate snapshot and the dispatched prompt digest before accepting a nonempty report. A first successful record adds `report_sha256`, `completed_at`, and an `orchestrator-attested` binding; primary, peer, and final-diff records cannot be overwritten. Every recorded stage requires nonempty `tool`, `model`, and `session_id`. Dispatch and session IDs must be audit-unique. Exact copied primary/peer/final-diff report bytes fail finalization. Final-diff and focused verification cannot be recorded before completed primary and peer stages, and a verifier cannot predate either prerequisite. Finalization independently requires valid nondecreasing primary, peer, and final-diff completion timestamps, requires every supplemental verifier to complete no earlier than peer, and requires every fixed or supplemental reviewer prompt and report path to equal its dispatched `audit.artifacts` entry before checking bytes and digests.

The peer prompt is a blind raw-target prompt and must contain no private review artifact or path. Repository-controlled profile fragments are omitted from this prompt; only fragments shipped with the installed audit-flow package may be included, and those are checked for private artifact references. Comparison happens only after `peer-review.md` is recorded. This is exposure reduction, not proof of what a reviewer actually saw.

After a focused verifier writes its report, record it with a unique, previously unused reviewer key:

```bash
node record-stage.mjs \
  --audit-yml .audit/local/audits/<audit-id>/audit.yml \
  --stage verification \
  --reviewer-key verifier-peer-only \
  --prompt verification-peer-only-prompt.md \
  --artifact verification-peer-only.md \
  --scope "peer-only findings" \
  --tool pi-subagent \
  --model openai/example \
  --session-id verifier-session-id
```

Every terminal finding names at least two concrete reviewer keys and lists each cited reviewer's exact report path in `verification.artifacts`. Supplemental reviewers require their own nonempty, bound prompt and report artifacts.

## Strict finalization

```bash
node finalize-audit.mjs \
  --audit-yml .audit/local/audits/<audit-id>/audit.yml \
  --status passed
```

Finalization accepts `passed`, `passed_with_deferred`, or `blocked`. It requires an unchanged target; completed primary, peer, and final-diff stages; matching nonempty prompt/report digests; nonempty tool/model/session identities; distinct dispatch/session IDs and fixed-stage report hashes; valid `findings.json` and nonempty `receipt.md`; exhaustive finding statuses; and concrete reviewer/artifact bindings for every finding. Finding verification never substitutes for the final-diff stage. Successful finalization atomically records:

```yaml
finalized_at: 2026-05-07T13:00:00Z
finalization:
  status: passed
  target_snapshot_sha256: 9a2d...e410
  findings_sha256: b1e2...a700
  receipt_sha256: 792a...a4d1
  required_stages:
    - primary
    - peer
    - final_diff
  completed_at: 2026-05-07T13:00:00Z
```

`audit.yml` updates are serialized by an audit-local lock and published by atomic rename. A failed validation leaves the metadata unchanged.

The attestation is unsigned local bookkeeping written by the caller/orchestrator. It proves only that this helper recorded a structurally consistent set of fields and digests. It does not cryptographically prove execution identity, report authorship, reviewer independence or blindness, direct inspection, or internal cognition.
