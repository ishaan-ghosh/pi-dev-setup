#!/usr/bin/env node

import { execFile } from "node:child_process";
import { lstat, readFile, readlink, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT = 1024 * 1024 * 1024;
const SUPPORTED_BLOB_MODES = new Set(["100644", "100755", "120000"]);

export async function verifyInstalledCheckout(checkoutPath, expectedCommit) {
	if (!/^[0-9a-f]{40,64}$/.test(String(expectedCommit))) {
		throw new Error(`Expected checkout commit is not an object ID: ${expectedCommit}`);
	}
	const root = await realpath(resolve(checkoutPath));
	const indexEntries = parseIndexEntries(root, await gitBuffer(root, "ls-files", "--stage", "-z", "--"));
	const expectedEntries = parseTreeEntries(root, await gitBuffer(root, "ls-tree", "-r", "-z", "--full-tree", expectedCommit, "--"));
	assertSameTrackedTree(root, indexEntries, expectedEntries);
	assertNoIndexCacheFlags(root, indexEntries, await gitBuffer(root, "ls-files", "-v", "-z", "--"));
	assertNoUnexpectedUntracked(root, await gitBuffer(root, "ls-files", "--others", "-z", "--", "."));

	for (const expected of expectedEntries) {
		await verifyRawEntry(root, expected);
	}
}

function assertNoUnexpectedUntracked(root, output) {
	const paths = splitNul(output)
		.map((entry) => decodeGitPath(root, entry))
		.filter((entryPath) => entryPath !== "package-lock.json");
	if (paths.length > 0) {
		throw new Error(`Installed checkout contains an untracked path outside the allowed generated set: ${paths[0]}`);
	}
}

function parseIndexEntries(root, output) {
	const entries = [];
	const seenPaths = new Set();
	for (const entry of splitNul(output)) {
		const tab = entry.indexOf(0x09);
		const header = tab < 0 ? "" : entry.subarray(0, tab).toString("ascii");
		const match = /^([0-7]{6}) ([0-9a-f]{40,64}) ([0-3])$/.exec(header);
		if (!match) throw new Error(`Installed checkout has malformed index metadata in ${root}.`);
		const path = decodeGitPath(root, entry.subarray(tab + 1));
		if (match[3] !== "0") throw new Error(`Installed checkout has an unmerged index entry: ${path}`);
		if (seenPaths.has(path)) throw new Error(`Installed checkout has duplicate index entries: ${path}`);
		seenPaths.add(path);
		entries.push({ path, mode: match[1], oid: match[2] });
	}
	return entries;
}

function parseTreeEntries(root, output) {
	const entries = [];
	const seenPaths = new Set();
	for (const entry of splitNul(output)) {
		const tab = entry.indexOf(0x09);
		const header = tab < 0 ? "" : entry.subarray(0, tab).toString("ascii");
		const match = /^([0-7]{6}) ([a-z]+) ([0-9a-f]{40,64})$/.exec(header);
		if (!match) throw new Error(`Expected release tree has malformed metadata in ${root}.`);
		const path = decodeGitPath(root, entry.subarray(tab + 1));
		if (match[1] === "160000" || match[2] === "commit") {
			throw new Error(`Installed checkout contains an unsupported tracked gitlink: ${path}`);
		}
		if (match[2] !== "blob" || !SUPPORTED_BLOB_MODES.has(match[1])) {
			throw new Error(`Installed checkout contains unsupported tracked mode ${match[1]} at ${path}`);
		}
		if (seenPaths.has(path)) throw new Error(`Expected release tree has duplicate paths: ${path}`);
		seenPaths.add(path);
		entries.push({ path, mode: match[1], oid: match[3] });
	}
	return entries;
}

function assertSameTrackedTree(root, indexEntries, expectedEntries) {
	if (indexEntries.length !== expectedEntries.length) {
		throw new Error(`Installed checkout index does not match the expected release tree in ${root}.`);
	}
	for (let index = 0; index < expectedEntries.length; index += 1) {
		const actual = indexEntries[index];
		const expected = expectedEntries[index];
		if (actual.path !== expected.path || actual.mode !== expected.mode || actual.oid !== expected.oid) {
			throw new Error(`Installed checkout index does not match the expected release tree at ${expected.path}.`);
		}
	}
}

function assertNoIndexCacheFlags(root, indexEntries, output) {
	const flags = new Map();
	for (const entry of splitNul(output)) {
		if (entry.length < 3 || entry[1] !== 0x20) {
			throw new Error(`Installed checkout has malformed index-flag metadata in ${root}.`);
		}
		const path = decodeGitPath(root, entry.subarray(2));
		if (flags.has(path)) throw new Error(`Installed checkout has duplicate index-flag entries: ${path}`);
		flags.set(path, String.fromCharCode(entry[0]));
	}
	if (flags.size !== indexEntries.length) {
		throw new Error(`Installed checkout index-flag inventory is incomplete in ${root}.`);
	}
	for (const entry of indexEntries) {
		const flag = flags.get(entry.path);
		if (flag !== "H") {
			throw new Error(`Installed checkout uses an unsupported index cache flag (${flag ?? "missing"}) at ${entry.path}.`);
		}
	}
}

async function verifyRawEntry(root, expected) {
	const absolutePath = resolveSafePath(root, expected.path);
	await assertNoSymlinkParents(root, absolutePath, expected.path);
	let fileStat;
	try {
		fileStat = await lstat(absolutePath);
	} catch (error) {
		if (error?.code === "ENOENT") throw new Error(`Installed checkout is missing tracked path: ${expected.path}`);
		throw error;
	}

	let actualMode;
	let actualBytes;
	if (fileStat.isSymbolicLink()) {
		actualMode = "120000";
		actualBytes = await readlink(absolutePath, { encoding: "buffer" });
	} else if (fileStat.isFile()) {
		actualMode = fileStat.mode & 0o111 ? "100755" : "100644";
		actualBytes = await readFile(absolutePath);
	} else {
		throw new Error(`Installed checkout has unsupported filesystem type at tracked path: ${expected.path}`);
	}
	if (actualMode !== expected.mode) {
		throw new Error(`Installed checkout worktree mode ${actualMode} does not match expected mode ${expected.mode} at ${expected.path}.`);
	}
	const expectedBytes = await gitBuffer(root, "cat-file", "blob", expected.oid);
	if (!actualBytes.equals(expectedBytes)) {
		throw new Error(`Installed checkout raw tracked content differs from the expected release at ${expected.path}.`);
	}
}

async function assertNoSymlinkParents(root, absolutePath, displayPath) {
	let current = root;
	const relativePath = relative(root, absolutePath);
	for (const component of relativePath.split(sep).slice(0, -1)) {
		current = resolve(current, component);
		if ((await lstat(current)).isSymbolicLink()) {
			throw new Error(`Installed checkout tracked path has a symbolic-link parent: ${displayPath}`);
		}
	}
}

function resolveSafePath(root, path) {
	const absolutePath = resolve(root, path);
	const relativePath = relative(root, absolutePath);
	if (!path || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
		throw new Error(`Installed checkout contains an unsafe tracked path: ${path}`);
	}
	return absolutePath;
}

function decodeGitPath(root, buffer) {
	const path = buffer.toString("utf8");
	if (Buffer.from(path, "utf8").compare(buffer) !== 0) {
		throw new Error(`Installed checkout contains a non-UTF-8 tracked path in ${root}.`);
	}
	resolveSafePath(root, path);
	return path;
}

function splitNul(buffer) {
	const values = [];
	let start = 0;
	for (let index = 0; index < buffer.length; index += 1) {
		if (buffer[index] !== 0) continue;
		if (index > start) values.push(buffer.subarray(start, index));
		start = index + 1;
	}
	if (start < buffer.length) values.push(buffer.subarray(start));
	return values;
}

async function gitBuffer(root, ...args) {
	try {
		const { stdout } = await execFileAsync("git", args, { cwd: root, encoding: null, maxBuffer: MAX_GIT_OUTPUT });
		return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
	} catch (error) {
		const detail = error?.stderr ? Buffer.from(error.stderr).toString("utf8").trim() : error?.message;
		throw new Error(`Unable to verify installed checkout Git state in ${root}: ${detail || "git command failed"}`);
	}
}

async function main() {
	const [checkoutPath, expectedCommit] = process.argv.slice(2);
	if (!checkoutPath || !expectedCommit) {
		throw new Error("Usage: node scripts/verify-installed-checkout.mjs <checkout-path> <expected-commit>");
	}
	await verifyInstalledCheckout(checkoutPath, expectedCommit);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
