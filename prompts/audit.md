---
description: Run a human-in-the-loop audit workflow
argument-hint: "<commit|diff|staged|pr|stack> [target]"
---
Use the `audit-flow` skill to run an explicit human-in-the-loop audit.

Run the primary-reviewer automation now:
1. Use `scripts/start-audit.mjs` to compose the selected repo profile, create `.pi/local/audits/<audit-id>/`, and generate `primary-reviewer-prompt.md` plus `peer-review-prompt.md`.
2. Launch a fresh read-only `reviewer` subagent with the generated primary prompt and save its output to `primary-initial.md`.
3. Run `scripts/record-stage.mjs --audit-yml <auditYmlPath> --stage primary --artifact <primaryInitialPath> --tool pi-subagent` to update `audit.yml` with primary-reviewer provenance.
4. Report the audit directory and the `peer-review-prompt.md` path for the next semi-manual peer-review step.

Audit request:
$ARGUMENTS
