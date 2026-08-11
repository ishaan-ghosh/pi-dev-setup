import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const bootstrapPath = path.join(repoRoot, "scripts/bootstrap.sh");
const releaseSha = "0123456789abcdef0123456789abcdef01234567";
const fakeBlobOid = "a".repeat(40);

async function writeExecutable(filePath, contents) {
	await writeFile(filePath, contents, "utf8");
	await chmod(filePath, 0o755);
}

async function makeHarness(mode) {
	const root = await mkdtemp(path.join(tmpdir(), "pi-bootstrap-"));
	const bin = path.join(root, "bin");
	const agent = path.join(root, "agent");
	const mutationLog = path.join(root, "mutations.log");
	const piInstalledMarker = path.join(root, "pi-installed.marker");
	await mkdir(bin, { recursive: true });
	await writeExecutable(path.join(bin, "date"), `#!/usr/bin/env bash
printf '%s\\n' '20260810120000'
`);
	await writeExecutable(path.join(bin, "git"), `#!/usr/bin/env bash
if [[ "$1" == "ls-remote" ]]; then
  [[ "$BOOTSTRAP_STUB_MODE" != "unpublished" ]] || exit 2
  printf '${releaseSha}\\trefs/tags/v0.2.0\\n'
  exit 0
fi
if [[ "$1" == "-C" ]]; then
  shift 2
  if [[ "$1 $2 $3" == "remote get-url origin" ]]; then
    printf '%s\\n' 'https://github.com/ishaan-ghosh/pi-dev-setup.git'
    exit 0
  fi
  if [[ "$1 $2" == "rev-parse HEAD" ]]; then
    printf '%s\\n' '${releaseSha}'
    exit 0
  fi
	  [[ "$1" == "diff" || "$1" == "status" ]] && exit 0
	fi
	if [[ "$1 $2" == "ls-files --stage" ]]; then
	  printf '100644 ${fakeBlobOid} 0\\tpackage.json\\0'
	  exit 0
	fi
	if [[ "$1 $2" == "ls-files -v" ]]; then
	  printf 'H package.json\\0'
	  exit 0
	fi
	if [[ "$1 $2" == "ls-files --others" ]]; then
	  exit 0
	fi
	if [[ "$1 $2" == "ls-tree -r" ]]; then
	  printf '100644 blob ${fakeBlobOid}\\tpackage.json\\0'
	  exit 0
	fi
	if [[ "$1 $2" == "cat-file blob" ]]; then
	  printf '%s\\n' '{"name":"pi-dev-setup","version":"0.2.0"}'
	  exit 0
	fi
	exit 91
`);
	await writeExecutable(path.join(bin, "curl"), `#!/usr/bin/env bash
url="\${!#}"
if [[ "$url" == */package.json ]]; then
  if [[ "$BOOTSTRAP_STUB_MODE" == "bad-content" ]]; then
    printf '%s\\n' '{"name":"pi-dev-setup","version":"WRONG","peerDependencies":{"@earendil-works/pi-coding-agent":"0.84.1"}}'
  else
    printf '%s\\n' '{"name":"pi-dev-setup","version":"0.2.0","peerDependencies":{"@earendil-works/pi-coding-agent":"0.84.1"}}'
  fi
elif [[ "$url" == */settings.example.json ]]; then
  printf '%s\\n' '{"releaseMarker":"verified-remote-content","packages":["git:https://github.com/ishaan-ghosh/pi-dev-setup@v0.2.0"]}'
else
  exit 92
fi
`);
	await writeExecutable(path.join(bin, "npm"), `#!/usr/bin/env bash
	printf 'npm %s\\n' "$*" >> "$BOOTSTRAP_MUTATION_LOG"
	if [[ "$BOOTSTRAP_STUB_MODE" == "wrong-pi-version" ]]; then
	  : > "$BOOTSTRAP_PI_INSTALLED_MARKER"
	fi
	`);
	await writeExecutable(path.join(bin, "pi"), `#!/usr/bin/env bash
if [[ "$1" == "--version" ]]; then
  if [[ "$BOOTSTRAP_STUB_MODE" == "race-checkout" ]]; then
    mkdir -p "$PI_CODING_AGENT_DIR/git/github.com/ishaan-ghosh/pi-dev-setup"
	    printf '%s\\n' concurrent > "$PI_CODING_AGENT_DIR/git/github.com/ishaan-ghosh/pi-dev-setup/concurrent.marker"
	  fi
	  if [[ "$BOOTSTRAP_STUB_MODE" == "wrong-pi-version" && ! -f "$BOOTSTRAP_PI_INSTALLED_MARKER" ]]; then
	    printf '%s\\n' '0.0.0'
	    exit 0
	  fi
	  printf '%s\\n' '0.84.1'
  exit 0
fi
printf 'pi %s\\n' "$*" >> "$BOOTSTRAP_MUTATION_LOG"
node -e '
  const fs = require("fs");
  const file = process.argv[1];
  const source = process.argv[2];
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  value.packages = value.packages ?? [];
	  const sourceOf = (entry) => typeof entry === "string" ? entry : entry?.source;
	  if (process.env.BOOTSTRAP_STUB_MODE === "filtered-entry") {
	    value.packages = value.packages.map((entry) => sourceOf(entry) === source
	      ? { source, extensions: [], skills: [], prompts: [], themes: [] }
	      : entry);
	    if (!value.packages.some((entry) => sourceOf(entry) === source)) {
	      value.packages.push({ source, extensions: [], skills: [], prompts: [], themes: [] });
	    }
	  } else if (!value.packages.some((entry) => sourceOf(entry) === source)) {
	    value.packages.push(source);
	  }
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\\n");
' "$PI_CODING_AGENT_DIR/settings.json" "$2"
checkout="$PI_CODING_AGENT_DIR/git/github.com/ishaan-ghosh/pi-dev-setup"
mkdir -p "$checkout/.git"
if [[ "$BOOTSTRAP_STUB_MODE" == "install-fail" ]]; then
  printf '%s\\n' partial > "$checkout/partial.marker"
  exit 1
fi
if [[ "$BOOTSTRAP_STUB_MODE" == "post-verify-fail" ]]; then
  printf '%s\\n' '{"name":"pi-dev-setup","version":"WRONG"}' > "$checkout/package.json"
else
  printf '%s\\n' '{"name":"pi-dev-setup","version":"0.2.0"}' > "$checkout/package.json"
fi
`);
	return {
		root,
		agent,
		mutationLog,
		env: {
			...process.env,
			PATH: `${bin}:${process.env.PATH}`,
			PI_CODING_AGENT_DIR: agent,
			BOOTSTRAP_STUB_MODE: mode,
			BOOTSTRAP_MUTATION_LOG: mutationLog,
			BOOTSTRAP_PI_INSTALLED_MARKER: piInstalledMarker,
		},
	};
}

async function runBlocked(harness, expectedMessage) {
	const before = await snapshotTree(harness.agent);
	await assert.rejects(
		() => execFileAsync("bash", [bootstrapPath], { cwd: repoRoot, env: harness.env }),
		(error) => {
			assert.match(error.stderr, expectedMessage);
			assert.match(error.stderr, /no global or user configuration changes were made/i);
			return true;
		},
	);
	assert.deepEqual(await snapshotTree(harness.agent), before);
	await assert.rejects(() => stat(harness.mutationLog), { code: "ENOENT" });
}

async function makeExactInstalledState(harness, packageEntry) {
	const checkout = path.join(harness.agent, "git/github.com/ishaan-ghosh/pi-dev-setup");
	await mkdir(path.join(checkout, ".git"), { recursive: true });
	await writeFile(path.join(checkout, "package.json"), '{"name":"pi-dev-setup","version":"0.2.0"}\n', "utf8");
	await writeFile(path.join(harness.agent, "settings.json"), `${JSON.stringify({ packages: [packageEntry] }, null, 2)}\n`, "utf8");
}

async function snapshotTree(root) {
	try {
		const result = {};
		async function walk(current, relativePath) {
			for (const name of (await readdir(current)).sort()) {
				const absolutePath = path.join(current, name);
				const childPath = path.join(relativePath, name);
				const childStat = await stat(absolutePath);
				if (childStat.isDirectory()) await walk(absolutePath, childPath);
				else result[childPath] = (await readFile(absolutePath)).toString("base64");
			}
		}
		await walk(root, "");
		return result;
	} catch (error) {
		if (error?.code === "ENOENT") return null;
		throw error;
	}
}

test("bootstrap makes zero user/global writes when the pinned tag is unpublished", async () => {
	const harness = await makeHarness("unpublished");
	await runBlocked(harness, /Required Pi setup tag is not published/);
});

test("bootstrap makes zero user/global writes when published release content is wrong", async () => {
	const harness = await makeHarness("bad-content");
	await runBlocked(harness, /package\.json does not match the pinned release contract/);
});

test("bootstrap makes zero user/global writes for a duplicate local extension", async () => {
	const harness = await makeHarness("ok");
	await mkdir(path.join(harness.agent, "extensions"), { recursive: true });
	await writeFile(path.join(harness.agent, "extensions/read-policy.ts"), "local policy\n", "utf8");
	await runBlocked(harness, /duplicate local read-policy/);
});

test("bootstrap makes zero user/global writes for conflicting configured package state", async () => {
	const harness = await makeHarness("ok");
	await mkdir(harness.agent, { recursive: true });
	const settingsPath = path.join(harness.agent, "settings.json");
	await writeFile(settingsPath, JSON.stringify({
		packages: ["git:https://github.com/ishaan-ghosh/pi-dev-setup"],
	}, null, 2), "utf8");
	await runBlocked(harness, /conflicting or unpinned Pi setup source/);
	await assert.rejects(() => stat(`${settingsPath}.backup`), { code: "ENOENT" });
});

test("bootstrap recognizes supported scp-style self-package locators before writes", async () => {
	const harness = await makeHarness("ok");
	await mkdir(harness.agent, { recursive: true });
	await writeFile(path.join(harness.agent, "settings.json"), JSON.stringify({
		packages: [`git:git@github.com:ishaan-ghosh/pi-dev-setup@${"1".repeat(40)}`],
	}, null, 2), "utf8");
	await runBlocked(harness, /conflicting or unpinned Pi setup source/);
});

test("bootstrap blocks an exact configured source whose checkout is missing without writes", async () => {
	const harness = await makeHarness("ok");
	await mkdir(harness.agent, { recursive: true });
	await writeFile(path.join(harness.agent, "settings.json"), JSON.stringify({
		packages: [`git:https://github.com/ishaan-ghosh/pi-dev-setup@${releaseSha}`],
	}, null, 2), "utf8");
	await runBlocked(harness, /configured Pi setup checkout is missing, modified, or not at published commit/);
});

test("bootstrap keeps exact string and source-only object self-package entries", async (t) => {
	for (const [name, makeEntry] of [
		["string", (source) => source],
		["source-only object", (source) => ({ source })],
	]) {
		await t.test(name, async () => {
			const harness = await makeHarness("ok");
			const source = `git:https://github.com/ishaan-ghosh/pi-dev-setup@${releaseSha}`;
			await makeExactInstalledState(harness, makeEntry(source));
			const before = await readFile(path.join(harness.agent, "settings.json"));
			const { stdout } = await execFileAsync("bash", [bootstrapPath], { cwd: repoRoot, env: harness.env });
			assert.match(stdout, /already installed at published commit/);
			assert.deepEqual(await readFile(path.join(harness.agent, "settings.json")), before);
			await assert.rejects(() => stat(harness.mutationLog), { code: "ENOENT" });
		});
	}
});

test("bootstrap rejects empty, partial, and malformed self-package filters without writes", async (t) => {
	for (const filter of ["extensions", "skills", "prompts", "themes"]) {
		for (const [shape, value] of [
			["empty", []],
			["partial", [`${filter}/only-one`]],
			["malformed", "all"],
		]) {
			await t.test(`${filter} ${shape}`, async () => {
				const harness = await makeHarness("ok");
				const source = `git:https://github.com/ishaan-ghosh/pi-dev-setup@${releaseSha}`;
				await makeExactInstalledState(harness, { source, [filter]: value });
				await runBlocked(harness, /filters do not match the reviewed release settings/);
			});
		}
	}
});

test("bootstrap installs and persists the exact resolved release commit", async () => {
	const harness = await makeHarness("ok");
	await execFileAsync("bash", [bootstrapPath], { cwd: repoRoot, env: harness.env });
	const settings = JSON.parse(await readFile(path.join(harness.agent, "settings.json"), "utf8"));
	assert.equal(settings.releaseMarker, "verified-remote-content");
	assert.deepEqual(settings.packages, [`git:https://github.com/ishaan-ghosh/pi-dev-setup@${releaseSha}`]);
	assert.equal(await readFile(harness.mutationLog, "utf8"), `pi install git:https://github.com/ishaan-ghosh/pi-dev-setup@${releaseSha} --no-approve\n`);
	assert.equal(JSON.parse(await readFile(path.join(harness.agent, "git/github.com/ishaan-ghosh/pi-dev-setup/package.json"), "utf8")).version, "0.2.0");
});

test("bootstrap uses --ignore-scripts exactly once when installing the supported Pi version", async () => {
	const harness = await makeHarness("wrong-pi-version");
	await execFileAsync("bash", [bootstrapPath], { cwd: repoRoot, env: harness.env });
	assert.equal(
		await readFile(harness.mutationLog, "utf8"),
		[
			"npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.84.1",
			`pi install git:https://github.com/ishaan-ghosh/pi-dev-setup@${releaseSha} --no-approve`,
			"",
		].join("\n"),
	);
});

test("all documented and executable global install commands disable lifecycle scripts", async () => {
	const bootstrap = await readFile(bootstrapPath, "utf8");
	const readme = await readFile(path.join(repoRoot, "README.md"), "utf8");
	const bootstrapCommands = bootstrap.split("\n").filter((line) => line.includes("npm install -g"));
	const documentedCommands = readme.split("\n").filter((line) => line.includes("npm install -g"));
	assert.equal(bootstrapCommands.length, 1);
	assert.equal(documentedCommands.length, 2);
	assert.ok([...bootstrapCommands, ...documentedCommands].every((line) => line.includes("--ignore-scripts")));
});

test("bootstrap restores settings and quarantines only a known-new partial checkout before retry", async () => {
	const harness = await makeHarness("install-fail");
	await assert.rejects(
		() => execFileAsync("bash", [bootstrapPath], { cwd: repoRoot, env: harness.env }),
		(error) => {
			assert.match(error.stderr, /removed the newly created settings file/);
			return true;
		},
	);
	await assert.rejects(() => stat(path.join(harness.agent, "settings.json")), { code: "ENOENT" });
	await assert.rejects(() => stat(path.join(harness.agent, "git/github.com/ishaan-ghosh/pi-dev-setup")), { code: "ENOENT" });
	const quarantine = await readdir(path.join(harness.agent, ".bootstrap-quarantine"));
	assert.equal(quarantine.length, 1);
	assert.equal(await readFile(path.join(harness.agent, ".bootstrap-quarantine", quarantine[0], "partial.marker"), "utf8"), "partial\n");

	await execFileAsync("bash", [bootstrapPath], {
		cwd: repoRoot,
		env: { ...harness.env, BOOTSTRAP_STUB_MODE: "ok" },
	});
	const settings = JSON.parse(await readFile(path.join(harness.agent, "settings.json"), "utf8"));
	assert.deepEqual(settings.packages, [`git:https://github.com/ishaan-ghosh/pi-dev-setup@${releaseSha}`]);
});

test("bootstrap rolls back when post-install exact-commit verification fails", async () => {
	const harness = await makeHarness("post-verify-fail");
	await assert.rejects(
		() => execFileAsync("bash", [bootstrapPath], { cwd: repoRoot, env: harness.env }),
		(error) => {
			assert.match(error.stderr, /exact-commit verification failed/);
			assert.match(error.stderr, /Quarantined the known-new partial checkout/);
			return true;
		},
	);
	await assert.rejects(() => stat(path.join(harness.agent, "settings.json")), { code: "ENOENT" });
	await assert.rejects(() => stat(path.join(harness.agent, "git/github.com/ishaan-ghosh/pi-dev-setup")), { code: "ENOENT" });
});

test("bootstrap refuses an existing settings backup without overwriting it", async () => {
	const harness = await makeHarness("ok");
	await mkdir(harness.agent, { recursive: true });
	await writeFile(path.join(harness.agent, "settings.json"), '{"packages":[]}\n', "utf8");
	const backupPath = path.join(harness.agent, "settings.json.backup.20260810120000");
	await writeFile(backupPath, "preserve me\n", "utf8");
	await runBlocked(harness, /Refusing to overwrite an existing settings backup/);
	assert.equal(await readFile(backupPath, "utf8"), "preserve me\n");
});

test("bootstrap does not quarantine a checkout that appears after preflight", async () => {
	const harness = await makeHarness("race-checkout");
	await assert.rejects(
		() => execFileAsync("bash", [bootstrapPath], { cwd: repoRoot, env: harness.env }),
		(error) => {
			assert.match(error.stderr, /checkout appeared after preflight/);
			return true;
		},
	);
	assert.equal(
		await readFile(path.join(harness.agent, "git/github.com/ishaan-ghosh/pi-dev-setup/concurrent.marker"), "utf8"),
		"concurrent\n",
	);
	await assert.rejects(() => stat(path.join(harness.agent, ".bootstrap-quarantine")), { code: "ENOENT" });
	await assert.rejects(() => stat(path.join(harness.agent, "settings.json")), { code: "ENOENT" });
});

test("bootstrap restores pre-existing settings after a failed install", async () => {
	const harness = await makeHarness("install-fail");
	await mkdir(harness.agent, { recursive: true });
	const settingsPath = path.join(harness.agent, "settings.json");
	const original = '{"theme":"dark","packages":[]}\n';
	await writeFile(settingsPath, original, "utf8");
	await assert.rejects(
		() => execFileAsync("bash", [bootstrapPath], { cwd: repoRoot, env: harness.env }),
		/Command failed/,
	);
	assert.equal(await readFile(settingsPath, "utf8"), original);
	assert.equal(await readFile(path.join(harness.agent, "settings.json.backup.20260810120000"), "utf8"), original);
	await assert.rejects(() => stat(path.join(harness.agent, "git/github.com/ishaan-ghosh/pi-dev-setup")), { code: "ENOENT" });
});

test("bootstrap restores byte-identical pre-existing settings when post-install filters are narrowed", async () => {
	const harness = await makeHarness("filtered-entry");
	await mkdir(harness.agent, { recursive: true });
	const settingsPath = path.join(harness.agent, "settings.json");
	const original = '{\n  "theme": "dark",\n  "packages": []\n}\n';
	await writeFile(settingsPath, original, "utf8");
	await assert.rejects(
		() => execFileAsync("bash", [bootstrapPath], { cwd: repoRoot, env: harness.env }),
		(error) => {
			assert.match(error.stderr, /exact-commit verification failed/);
			assert.match(error.stderr, /Quarantined the known-new partial checkout/);
			return true;
		},
	);
	assert.equal(await readFile(settingsPath, "utf8"), original);
	assert.equal(await readFile(path.join(harness.agent, "settings.json.backup.20260810120000"), "utf8"), original);
	await assert.rejects(() => stat(path.join(harness.agent, "git/github.com/ishaan-ghosh/pi-dev-setup")), { code: "ENOENT" });
});
