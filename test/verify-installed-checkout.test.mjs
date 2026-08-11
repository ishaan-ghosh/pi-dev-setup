import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { promisify } from "node:util";

import { verifyInstalledCheckout } from "../scripts/verify-installed-checkout.mjs";

const execFileAsync = promisify(execFile);

async function createCheckout(prefix = "pi-installed-checkout-", setup = async () => {}) {
	const root = await mkdtemp(path.join(tmpdir(), prefix));
	const checkout = path.join(root, "checkout");
	await mkdir(checkout);
	await execFileAsync("git", ["init", "-q"], { cwd: checkout });
	await execFileAsync("git", ["remote", "add", "origin", "https://github.com/ishaan-ghosh/pi-dev-setup.git"], { cwd: checkout });
	await writeFile(path.join(checkout, "package.json"), '{"name":"pi-dev-setup","version":"0.2.0"}\n');
	await setup({ root, checkout });
	await execFileAsync("git", ["add", "."], { cwd: checkout });
	await execFileAsync(
		"git",
		["-c", "user.name=Verifier", "-c", "user.email=verifier@example.invalid", "commit", "-q", "-m", "release"],
		{ cwd: checkout },
	);
	const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: checkout });
	return { root, checkout, commit: stdout.trim() };
}

async function writeToStdin(command, args, input, options = {}) {
	await new Promise((resolvePromise, reject) => {
		const child = spawn(command, args, { ...options, stdio: ["pipe", "pipe", "pipe"] });
		const stderr = [];
		child.stderr.on("data", (chunk) => stderr.push(chunk));
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) resolvePromise();
			else reject(new Error(`${command} exited ${code}: ${Buffer.concat(stderr).toString("utf8")}`));
		});
		child.stdin.end(input);
	});
}

test("installed checkout verifier accepts exact raw tracked files and symlinks", async () => {
	const fixture = await createCheckout("pi-installed-exact-", async ({ checkout }) => {
		await writeFile(path.join(checkout, "tool.sh"), "#!/bin/sh\n");
		await chmod(path.join(checkout, "tool.sh"), 0o755);
		await symlink("tool.sh", path.join(checkout, "tool-link"));
	});
	await verifyInstalledCheckout(fixture.checkout, fixture.commit);
});

test("installed checkout verifier rejects untracked files hidden by Git excludes", async (t) => {
	for (const mode of ["info-exclude", "core-excludes-file"]) {
		await t.test(mode, async () => {
			const fixture = await createCheckout(`pi-installed-${mode}-`);
			await mkdir(path.join(fixture.checkout, "extensions"), { recursive: true });
			await writeFile(path.join(fixture.checkout, "extensions/extra.ts"), "// inert fixture\n");
			if (mode === "info-exclude") {
				await writeFile(path.join(fixture.checkout, ".git/info/exclude"), "extensions/extra.ts\n");
			} else {
				const excludesFile = path.join(fixture.root, "fixture-excludes");
				await writeFile(excludesFile, "extensions/extra.ts\n");
				await execFileAsync("git", ["config", "core.excludesFile", excludesFile], { cwd: fixture.checkout });
			}
			const { stdout } = await execFileAsync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: fixture.checkout });
			assert.equal(stdout, "");
			await assert.rejects(
				() => verifyInstalledCheckout(fixture.checkout, fixture.commit),
				/untracked path outside the allowed generated set: extensions\/extra\.ts/,
			);
		});
	}
});

test("installed checkout verifier permits only an untracked top-level package lock", async () => {
	const fixture = await createCheckout("pi-installed-generated-lock-");
	await writeFile(path.join(fixture.checkout, "package-lock.json"), '{"lockfileVersion":3}\n');
	await verifyInstalledCheckout(fixture.checkout, fixture.commit);

	await mkdir(path.join(fixture.checkout, "nested"));
	await writeFile(path.join(fixture.checkout, "nested/package-lock.json"), '{"lockfileVersion":3}\n');
	await assert.rejects(
		() => verifyInstalledCheckout(fixture.checkout, fixture.commit),
		/untracked path outside the allowed generated set: nested\/package-lock\.json/,
	);
});

test("installed checkout verifier rejects assume-unchanged and skip-worktree flags", async (t) => {
	for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
		await t.test(flag, async () => {
			const fixture = await createCheckout(`pi-installed-${flag.slice(2)}-`, async ({ checkout }) => {
				await writeFile(path.join(checkout, "tracked.txt"), "expected\n");
			});
			await execFileAsync("git", ["update-index", flag, "tracked.txt"], { cwd: fixture.checkout });
			await assert.rejects(
				() => verifyInstalledCheckout(fixture.checkout, fixture.commit),
				/unsupported index cache flag/,
			);
		});
	}
});

test("installed checkout verifier binds raw bytes, executable mode, missing state, and tracked lockfiles", async (t) => {
	for (const [name, setup, mutate, expected] of [
		[
			"raw byte drift",
			async ({ checkout }) => writeFile(path.join(checkout, "tracked.txt"), "expected\n"),
			async ({ checkout }) => writeFile(path.join(checkout, "tracked.txt"), "changed\n"),
			/raw tracked content differs/,
		],
		[
			"executable mode drift",
			async ({ checkout }) => writeFile(path.join(checkout, "tool.sh"), "#!/bin/sh\n"),
			async ({ checkout }) => chmod(path.join(checkout, "tool.sh"), 0o755),
			/worktree mode 100755 does not match expected mode 100644/,
		],
		[
			"missing tracked path",
			async ({ checkout }) => writeFile(path.join(checkout, "tracked.txt"), "expected\n"),
			async ({ root, checkout }) => rename(path.join(checkout, "tracked.txt"), path.join(root, "saved-tracked.txt")),
			/missing tracked path/,
		],
		[
			"tracked package-lock drift",
			async ({ checkout }) => writeFile(path.join(checkout, "package-lock.json"), '{"lockfileVersion":3}\n'),
			async ({ checkout }) => writeFile(path.join(checkout, "package-lock.json"), '{"lockfileVersion":2}\n'),
			/raw tracked content differs.*package-lock\.json/,
		],
	]) {
		await t.test(name, async () => {
			const fixture = await createCheckout(`pi-installed-${name.replaceAll(" ", "-")}-`, setup);
			await mutate(fixture);
			await assert.rejects(() => verifyInstalledCheckout(fixture.checkout, fixture.commit), expected);
		});
	}
});

test("installed checkout verifier binds regular/symlink type and raw link text", async (t) => {
	await t.test("regular to symlink", async () => {
		const fixture = await createCheckout("pi-installed-regular-link-", async ({ checkout }) => {
			await writeFile(path.join(checkout, "entry"), "regular\n");
		});
		await rename(path.join(fixture.checkout, "entry"), path.join(fixture.root, "saved-regular"));
		await symlink("target", path.join(fixture.checkout, "entry"));
		await assert.rejects(() => verifyInstalledCheckout(fixture.checkout, fixture.commit), /worktree mode 120000.*expected mode 100644/);
	});

	await t.test("symlink to regular", async () => {
		const fixture = await createCheckout("pi-installed-link-regular-", async ({ checkout }) => {
			await symlink("target", path.join(checkout, "entry"));
		});
		await rename(path.join(fixture.checkout, "entry"), path.join(fixture.root, "saved-link"));
		await writeFile(path.join(fixture.checkout, "entry"), "regular\n");
		await assert.rejects(() => verifyInstalledCheckout(fixture.checkout, fixture.commit), /worktree mode 100644.*expected mode 120000/);
	});

	await t.test("symlink text drift", async () => {
		const fixture = await createCheckout("pi-installed-link-text-", async ({ checkout }) => {
			await symlink("target-one", path.join(checkout, "entry"));
		});
		await rename(path.join(fixture.checkout, "entry"), path.join(fixture.root, "saved-link"));
		await symlink("target-two", path.join(fixture.checkout, "entry"));
		await assert.rejects(() => verifyInstalledCheckout(fixture.checkout, fixture.commit), /raw tracked content differs.*entry/);
	});
});

test("installed checkout verifier fails closed on unmerged entries, gitlinks, and special files", async (t) => {
	await t.test("unmerged index", async () => {
		const fixture = await createCheckout("pi-installed-unmerged-", async ({ checkout }) => {
			await writeFile(path.join(checkout, "tracked.txt"), "base\n");
		});
		const first = (await execFileAsync("git", ["rev-parse", "HEAD:tracked.txt"], { cwd: fixture.checkout })).stdout.trim();
		const second = (await execFileAsync("git", ["rev-parse", "HEAD:package.json"], { cwd: fixture.checkout })).stdout.trim();
		await execFileAsync("git", ["update-index", "--force-remove", "tracked.txt"], { cwd: fixture.checkout });
		await writeToStdin(
			"git",
			["update-index", "--index-info"],
			`100644 ${first} 1\ttracked.txt\n100644 ${second} 2\ttracked.txt\n`,
			{ cwd: fixture.checkout },
		);
		await assert.rejects(() => verifyInstalledCheckout(fixture.checkout, fixture.commit), /unmerged index entry/);
	});

	await t.test("tracked gitlink", async () => {
		const fixture = await createCheckout("pi-installed-gitlink-");
		await execFileAsync("git", ["update-index", "--add", "--cacheinfo", `160000,${fixture.commit},vendor/module`], { cwd: fixture.checkout });
		await execFileAsync(
			"git",
			["-c", "user.name=Verifier", "-c", "user.email=verifier@example.invalid", "commit", "-q", "-m", "gitlink"],
			{ cwd: fixture.checkout },
		);
		const commit = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: fixture.checkout })).stdout.trim();
		await assert.rejects(() => verifyInstalledCheckout(fixture.checkout, commit), /unsupported tracked gitlink/);
	});

	await t.test("special filesystem entry", async () => {
		const fixture = await createCheckout("pi-installed-special-", async ({ checkout }) => {
			await writeFile(path.join(checkout, "entry"), "regular\n");
		});
		await rename(path.join(fixture.checkout, "entry"), path.join(fixture.root, "saved-entry"));
		await execFileAsync("mkfifo", [path.join(fixture.checkout, "entry")]);
		await assert.rejects(() => verifyInstalledCheckout(fixture.checkout, fixture.commit), /unsupported filesystem type/);
	});
});
