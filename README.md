# pi-dev-setup

Shared Pi coding-agent setup for my machines and coworkers.

This repository is a Pi package. It can bundle:

- `extensions/` — TypeScript/JavaScript Pi extensions
- `skills/` — Agent Skills
- `prompts/` — slash-command prompt templates
- `themes/` — TUI themes

Current contents:

- `extensions/read-policy.ts` — nudges agents toward `grep`/`find`/`ls` first and paginated `read` calls by default.
- `skills/audit-flow` — human-in-the-loop commit/PR/platform audit workflow with repo-local prompt profiles and local artifact receipts.
- `prompts/audit.md` — slash-command prompt template for starting the audit flow.
- Vendored skills:
  - `grill-with-docs`
  - `diagnose`
  - `improve-codebase-architecture`
  - `tdd`
  - `to-prd`
- `settings.example.json` — non-secret global settings template matching my current setup.

The vendored skills come from [`mattpocock/skills`](https://github.com/mattpocock/skills); see [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

## Install

```bash
npm install -g @mariozechner/pi-coding-agent
pi install git:https://github.com/ishaan-ghosh/pi-dev-setup
```

Then authenticate locally:

```text
/login
```

Or configure provider credentials with environment variables or your secret manager.

## Full machine bootstrap

```bash
git clone https://github.com/ishaan-ghosh/pi-dev-setup.git
cd pi-dev-setup
./scripts/bootstrap.sh
```

The bootstrap script will not overwrite an existing `~/.pi/agent/settings.json`; it backs it up and installs this package instead. If a local `~/.pi/agent/extensions/read-policy.ts` exists, it moves it to `~/.pi/agent/extensions/.local-backup/` so the extension is not loaded twice.

## Optional settings sync

To use the example settings as your global Pi settings on a fresh machine:

```bash
mkdir -p ~/.pi/agent
cp settings.example.json ~/.pi/agent/settings.json
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

## Update

```bash
pi update --extensions
```

Or update Pi itself and packages:

```bash
pi update
```

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

This usually means scoped model cycling was configured before the provider was authenticated, or Pi's model registry is older than the model names in your settings. Run `/login`, then configure cycling with `/scoped-models`. If needed, update Pi:

```bash
npm install -g @mariozechner/pi-coding-agent@latest
```
