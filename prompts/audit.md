---
description: Run a human-in-the-loop audit workflow
argument-hint: "<commit|diff|staged|pr|stack> [target]"
---
Use the `audit-flow` skill to run an explicit human-in-the-loop audit.

Run the primary-reviewer automation now:
1. Use `scripts/start-audit.mjs` to compose the selected repo profile, bind the exact Git target snapshot, create `.audit/local/audits/<audit-id>/` (or the legacy `.pi/local/audits/` fallback), and generate primary, blind-peer, and final-diff prompts.
2. Launch a fresh read-only `reviewer` subagent with the generated primary prompt and save its output to `primary-initial.md`.
3. Run `scripts/record-stage.mjs --audit-yml <auditYmlPath> --stage primary --artifact <primaryInitialPath> --tool pi-subagent --model <actual-model> --session-id <actual-session-id>` to record structural primary-reviewer provenance. Do not fabricate unavailable identity values.
4. Report the audit directory and the blind `peer-review-prompt.md` path for the next semi-manual raw-target peer step. Do not disclose primary artifacts to that peer until its report is recorded. Later, record the distinct mandatory `final-diff` stage and run `finalize-audit.mjs` only after findings and receipt artifacts are complete.

Audit request:
$ARGUMENTS
