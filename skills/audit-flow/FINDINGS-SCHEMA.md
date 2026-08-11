# Audit findings schema v1

Findings should have stable IDs and structured status fields from the beginning. The v1 workflow treats this as a documented convention that can later become a strict validator.

```json
{
  "id": "F-001",
  "title": "Run status is not updated when one benchmark job fails",
  "severity": "high",
  "confidence": "confirmed",
  "source": ["primary", "peer"],
  "verification": {
    "required": 2,
    "artifacts": ["primary-initial.md", "peer-review.md"]
  },
  "status": "accepted",
  "target": {
    "repo": "backend",
    "file": "app/services/eval_service.py",
    "line": 214
  },
  "impact": "Multi-job benchmark runs can report success even when a child job fails.",
  "evidence": "The aggregation path only checks completed jobs and ignores failed child statuses.",
  "recommended_action": "fix",
  "github_comment": {
    "mode": "inline",
    "body": "..."
  }
}
```

## Required fields

- `id`: Stable per-audit ID such as `F-001`.
- `title`: Short human-readable finding title.
- `severity`: `critical | high | medium | low`.
- `confidence`: `confirmed | likely | speculative | question`.
- `source`: At least two concrete keys from `audit.yml.reviewers`, such as `primary`, `peer`, or a supplemental key such as `verifier_peer_only`. Generic role names are invalid. Each cited key must identify a completed reviewer with nonempty tool/model/session metadata and a structural orchestrator attestation.
- `verification.required`: Integer of at least 2. The number of distinct cited reviewer keys must meet it.
- `verification.artifacts`: An array containing only concrete nonempty strings. It must contain the exact `reviewers.<key>.artifact` value for every cited source.
- `status`: `candidate | unverified | accepted | rejected | deferred | needs_more_info | fixed | partially_fixed | still_open | verified | commented`.
- `impact`: User/product/runtime impact.
- `evidence`: Concrete evidence, preferably with file/line references or command results.
- `recommended_action`: `fix | comment | defer | ignore | investigate`.

## Optional fields

- `target.repo`: Named repo for multi-repo audits.
- `target.file`: File path relative to the repo root.
- `target.line`: 1-indexed line number when there is a stable anchor.
- `target.end_line`: Optional end line.
- `github_comment`: Proposed GitHub review comment information after human acceptance.
- `decision_reason`: Human reason for accepting, rejecting, or deferring.
- `validation`: Commands/results relevant to this finding.

## Status lifecycle

```txt
candidate → accepted → fixed → verified
candidate → unverified → rejected/deferred/needs_more_info
candidate → accepted → partially_fixed → fixed/still_open
candidate → accepted → still_open
candidate → accepted → commented
candidate → rejected
candidate → deferred
candidate → needs_more_info → accepted/rejected/deferred
```

Reviewer sessions should generally create `candidate` findings. Before human drill-down or synthesis, the parent audit cockpit compares provenance and evidence for every candidate. Primary-plus-peer confirmation may satisfy the policy gate when both exact artifacts are cited. A primary-only, peer-only, missed, or disputed finding requires a fresh focused reviewer, a bound `verification-<name>-prompt.md`, and a `verification-<name>.md` report. One-source allegations belong outside terminal `findings.json` as open questions; changing their status does not bypass the terminal two-source gate.

Strict finalization rejects a missing or unknown status and recognizes exactly the 11 statuses listed above. Every terminal finding, including `rejected` and `deferred`, must meet its `verification.required` count, cite at least two concrete reviewer keys, bind each exact report in `verification.artifacts`, and cite distinct report bytes. A non-blocked final status rejects unresolved findings. `passed` rejects deferred findings, while `passed_with_deferred` requires at least one deferred finding. This structural gate is separate from the mandatory full-target `final_diff` stage.

These checks validate locally recorded structure and caller/orchestrator attestations. They are not cryptographic proof of report authorship, reviewer independence, blindness, or internal reasoning. Rejecting equal report hashes is copy-error defense, not proof that different hashes came from independent cognition.
