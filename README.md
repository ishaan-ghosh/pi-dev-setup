# pi-dev-setup

Shared Pi coding-agent setup for my machines and coworkers.

This repository is a Pi package. It can bundle:

- `extensions/` — TypeScript/JavaScript Pi extensions
- `skills/` — Agent Skills
- `prompts/` — slash-command prompt templates
- `themes/` — TUI themes

Current contents:

- `extensions/read-policy.ts` — nudges agents toward `grep`/`find`/`ls` first and paginated `read` calls by default.
- `settings.example.json` — non-secret global settings template matching my current setup.

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

The bootstrap script will not overwrite an existing `~/.pi/agent/settings.json`; it backs it up and installs this package instead.

## Optional settings sync

To use the example settings as your global Pi settings on a fresh machine:

```bash
mkdir -p ~/.pi/agent
cp settings.example.json ~/.pi/agent/settings.json
```

Review `settings.example.json` first. It includes model preferences and packages I use:

- `npm:pi-subagents`
- `npm:pi-mcp-adapter`
- `npm:context-mode`
- `git:https://github.com/hasit/pi-community-themes`
- selected skills from `git:https://github.com/mattpocock/skills.git`

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
