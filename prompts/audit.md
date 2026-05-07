---
description: Run a human-in-the-loop audit workflow
argument-hint: "<commit|diff|staged|pr|stack> [target]"
---
Use the `audit-flow` skill to run an explicit human-in-the-loop audit. Start with the skill's minimal v1 helper (`scripts/start-audit.mjs`) to compose the selected repo profile, create `.pi/local/audits/<audit-id>/`, and generate `primary-reviewer-prompt.md` plus `peer-review-prompt.md`.

Audit request:
$ARGUMENTS
