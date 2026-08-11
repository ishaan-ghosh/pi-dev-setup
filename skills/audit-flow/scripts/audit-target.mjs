import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readlink, realpath } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT = 1024 * 1024 * 1024;

export async function captureTargetSnapshot({ projectRoot, profile, baseRef, headRef }) {
	const targets = resolveTargetRepos({ projectRoot, profile, baseRef, headRef });
	const repos = [];
	const seenRoots = new Set();

	for (const target of targets) {
		const repo = await captureRepositorySnapshot(target);
		if (seenRoots.has(repo.root)) {
			throw new Error(`Audit target lists the same git repository more than once: ${repo.root}`);
		}
		seenRoots.add(repo.root);
		repos.push(repo);
	}

	const snapshot = {
		snapshot_schema: "git-worktree-v2",
		repos,
	};
	snapshot.snapshot_sha256 = sha256(stableStringify(repos.map(snapshotIdentity)));
	return snapshot;
}

export async function revalidateTargetSnapshot(target) {
	if (target?.snapshot_schema !== "git-worktree-v2" || !Array.isArray(target.repos) || target.repos.length === 0) {
		throw new Error("Audit metadata does not contain a valid git-worktree-v2 target snapshot; start a new audit with raw tracked-worktree binding.");
	}

	const currentRepos = [];
	const changedRepos = [];
	for (const expected of target.repos) {
		const current = await captureRepositorySnapshot({
			name: expected.name,
			role: expected.role ?? null,
			path: expected.root,
			baseRef: expected.base_ref,
			headRef: expected.head_ref,
		});
		currentRepos.push(current);
		if (current.snapshot_sha256 !== expected.snapshot_sha256) {
			changedRepos.push(expected.name);
		}
	}

	const currentDigest = sha256(stableStringify(currentRepos.map(snapshotIdentity)));
	if (currentDigest !== target.snapshot_sha256 || changedRepos.length > 0) {
		throw new Error(
			`Audit target snapshot changed after dispatch${changedRepos.length ? ` (${changedRepos.join(", ")})` : ""}; start a new audit for the new target.`,
		);
	}
	return currentRepos;
}

function resolveTargetRepos({ projectRoot, profile, baseRef, headRef }) {
	const auditType = String(profile.type ?? profile.name ?? "").trim().toLowerCase();
	const requireExplicitRange = auditType === "pr" || auditType === "stack";
	if (Array.isArray(profile.repos) && profile.repos.length > 0) {
		const contextRootValue = profile.platform?.context_root;
		const contextRoot = contextRootValue
			? (isAbsolute(contextRootValue) ? contextRootValue : resolve(projectRoot, contextRootValue))
			: projectRoot;
		return profile.repos.map((repo, index) => {
			if (!repo?.name || !repo?.path) {
				throw new Error(`Profile repos[${index}] must define both name and path.`);
			}
			const resolvedBaseRef = repo.base ?? baseRef ?? profile.base;
			const resolvedHeadRef = repo.head ?? headRef ?? profile.head;
			assertExplicitRange(resolvedBaseRef, resolvedHeadRef, requireExplicitRange, `repos[${index}]`);
			return {
				name: String(repo.name),
				role: repo.role === undefined ? null : String(repo.role),
				path: isAbsolute(repo.path) ? repo.path : resolve(contextRoot, repo.path),
				baseRef: String(resolvedBaseRef ?? "HEAD"),
				headRef: String(resolvedHeadRef ?? "HEAD"),
				requireDistinctRange: requireExplicitRange,
			};
		});
	}
	const resolvedBaseRef = baseRef ?? profile.base;
	const resolvedHeadRef = headRef ?? profile.head;
	assertExplicitRange(resolvedBaseRef, resolvedHeadRef, requireExplicitRange, "profile");

	return [{
		name: null,
		role: null,
		path: projectRoot,
		baseRef: String(resolvedBaseRef ?? "HEAD"),
		headRef: String(resolvedHeadRef ?? "HEAD"),
		requireDistinctRange: requireExplicitRange,
	}];
}

function assertExplicitRange(baseRef, headRef, required, label) {
	if (!required) return;
	if (typeof baseRef !== "string" || baseRef.trim() === "" || typeof headRef !== "string" || headRef.trim() === "") {
		throw new Error(`PR/stack audits require explicit base and head refs for ${label}; pass --base and --head or configure both in the profile.`);
	}
}

async function captureRepositorySnapshot(target) {
	const requestedRoot = await realpath(resolve(target.path)).catch(() => resolve(target.path));
	const topLevel = await gitText(requestedRoot, "rev-parse", "--show-toplevel");
	if (!topLevel) {
		throw new Error(`Audit target is not inside a git repository: ${requestedRoot}`);
	}
	const root = await realpath(topLevel);
	const baseOid = await requireCommit(root, target.baseRef, "base");
	const headOid = await requireCommit(root, target.headRef, "head");
	if (target.requireDistinctRange && baseOid === headOid) {
		throw new Error(`PR/stack audit base and head resolve to the same commit in ${root}; provide the explicit non-empty review range.`);
	}
	const stagedDiff = await gitBuffer(
		root,
		"diff",
		"--cached",
		"--binary",
		"--full-index",
		"--no-ext-diff",
		"--no-textconv",
		"--no-color",
		headOid,
		"--",
	);
	const unstagedDiff = await gitBuffer(
		root,
		"diff",
		"--binary",
		"--full-index",
		"--no-ext-diff",
		"--no-textconv",
		"--no-color",
		"--",
	);
	const tracked = await readTrackedManifest(root);
	const trackedManifestSha256 = sha256(stableStringify(tracked));
	const untracked = await readUntrackedManifest(root);
	const untrackedManifestSha256 = sha256(stableStringify(untracked));

	const repo = {
		name: target.name ?? basename(root),
		role: target.role ?? null,
		root,
		base_ref: String(target.baseRef),
		base_oid: baseOid,
		head_ref: String(target.headRef),
		head_oid: headOid,
		staged_diff_sha256: sha256(stagedDiff),
		unstaged_diff_sha256: sha256(unstagedDiff),
		tracked_manifest_sha256: trackedManifestSha256,
		tracked,
		untracked_manifest_sha256: untrackedManifestSha256,
		untracked,
	};
	repo.snapshot_sha256 = sha256(stableStringify(snapshotIdentity(repo)));
	return repo;
}

async function readTrackedManifest(root) {
	const output = await gitBuffer(root, "ls-files", "--stage", "-z");
	const rawEntries = splitNul(output).map((entry) => parseIndexEntry(root, entry));
	rawEntries.sort((left, right) => Buffer.compare(left.pathBuffer, right.pathBuffer));
	const seenPaths = new Set();
	const entries = [];
	for (const rawEntry of rawEntries) {
		if (rawEntry.stage !== "0") {
			throw new Error(`Audit target contains an unmerged index entry at ${rawEntry.path} in ${root}.`);
		}
		if (seenPaths.has(rawEntry.path)) {
			throw new Error(`Audit target contains duplicate index entries at ${rawEntry.path} in ${root}.`);
		}
		seenPaths.add(rawEntry.path);
		if (rawEntry.indexMode === "160000") {
			throw new Error(`Audit target contains unsupported submodule gitlink ${rawEntry.path} in ${root}; audit submodules as separate repositories.`);
		}
		if (!["100644", "100755", "120000"].includes(rawEntry.indexMode)) {
			throw new Error(`Audit target contains unsupported tracked mode ${rawEntry.indexMode} at ${rawEntry.path} in ${root}.`);
		}
		const worktree = await readRawWorktreeEntry(root, rawEntry.path);
		entries.push({
			path: rawEntry.path,
			index_mode: rawEntry.indexMode,
			index_oid: rawEntry.indexOid,
			worktree_mode: worktree.mode,
			sha256: worktree.sha256,
		});
	}
	return entries;
}

function parseIndexEntry(root, entry) {
	const separator = entry.indexOf(0x09);
	if (separator < 0) {
		throw new Error(`Unable to parse tracked index entry in ${root}.`);
	}
	const header = entry.subarray(0, separator).toString("ascii");
	const match = /^([0-7]{6}) ([0-9a-f]{40,64}) ([0-3])$/.exec(header);
	if (!match) {
		throw new Error(`Unable to parse tracked index metadata in ${root}.`);
	}
	const pathBuffer = entry.subarray(separator + 1);
	const path = decodeGitPath(root, pathBuffer, "tracked");
	return { indexMode: match[1], indexOid: match[2], stage: match[3], path, pathBuffer };
}

async function readRawWorktreeEntry(root, path) {
	await assertNoSymlinkParents(root, path);
	const absolutePath = resolve(root, path);
	let fileStat;
	try {
		fileStat = await lstat(absolutePath);
	} catch (error) {
		if (error?.code === "ENOENT") return { mode: "missing", sha256: null };
		throw error;
	}
	if (fileStat.isSymbolicLink()) {
		return { mode: "120000", sha256: sha256(await readlink(absolutePath, { encoding: "buffer" })) };
	}
	if (fileStat.isFile()) {
		return { mode: fileStat.mode & 0o111 ? "100755" : "100644", sha256: sha256(await readFile(absolutePath)) };
	}
	throw new Error(`Unsupported tracked worktree entry (expected file, symlink, or missing path): ${absolutePath}`);
}

async function readUntrackedManifest(root) {
	const output = await gitBuffer(root, "ls-files", "--others", "--exclude-standard", "-z");
	const pathBuffers = splitNul(output).sort(Buffer.compare);
	const entries = [];
	for (const pathBuffer of pathBuffers) {
		const path = decodeGitPath(root, pathBuffer, "untracked");
		await assertNoSymlinkParents(root, path);
		const absolutePath = resolve(root, path);
		const fileStat = await lstat(absolutePath);
		let mode;
		let contents;
		if (fileStat.isSymbolicLink()) {
			mode = "120000";
			contents = await readlink(absolutePath, { encoding: "buffer" });
		} else if (fileStat.isFile()) {
			mode = fileStat.mode & 0o111 ? "100755" : "100644";
			contents = await readFile(absolutePath);
		} else {
			throw new Error(`Unsupported untracked target entry (expected file or symlink): ${absolutePath}`);
		}
		entries.push({ path, mode, sha256: sha256(contents) });
	}
	return entries;
}

async function assertNoSymlinkParents(root, path) {
	let current = root;
	for (const component of path.split("/").slice(0, -1)) {
		current = resolve(current, component);
		let componentStat;
		try {
			componentStat = await lstat(current);
		} catch (error) {
			if (error?.code === "ENOENT") return;
			throw error;
		}
		if (componentStat.isSymbolicLink()) {
			throw new Error(`Audit target path has a symbolic-link parent beneath the repository root: ${current}`);
		}
	}
}

function decodeGitPath(root, pathBuffer, kind) {
	const path = pathBuffer.toString("utf8");
	if (Buffer.from(path, "utf8").compare(pathBuffer) !== 0) {
		throw new Error(`Audit target contains a non-UTF-8 ${kind} path in ${root}.`);
	}
	if (isAbsolute(path) || path.split(/[\\/]/).includes("..")) {
		throw new Error(`Audit target contains an unsafe ${kind} path in ${root}: ${path}`);
	}
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

async function requireCommit(root, ref, label) {
	const oid = await gitText(root, "rev-parse", "--verify", `${ref}^{commit}`);
	if (!oid || !/^[0-9a-f]{40,64}$/.test(oid)) {
		throw new Error(`Unable to resolve audit ${label} ref ${ref} to a commit in ${root}.`);
	}
	return oid;
}

function snapshotIdentity(repo) {
	return {
		name: repo.name,
		role: repo.role ?? null,
		root: repo.root,
		base_ref: repo.base_ref,
		base_oid: repo.base_oid,
		head_ref: repo.head_ref,
		head_oid: repo.head_oid,
		staged_diff_sha256: repo.staged_diff_sha256,
		unstaged_diff_sha256: repo.unstaged_diff_sha256,
		tracked_manifest_sha256: repo.tracked_manifest_sha256,
		tracked: repo.tracked,
		untracked_manifest_sha256: repo.untracked_manifest_sha256,
		untracked: repo.untracked,
	};
}

async function gitText(root, ...args) {
	try {
		const output = await gitBuffer(root, ...args);
		return output.toString("utf8").trim();
	} catch {
		return null;
	}
}

async function gitBuffer(root, ...args) {
	const { stdout } = await execFileAsync("git", args, {
		cwd: root,
		encoding: null,
		maxBuffer: MAX_GIT_OUTPUT,
	});
	return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
}

export function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}

export function stableStringify(value) {
	if (Array.isArray(value)) {
		return `[${value.map((item) => stableStringify(item)).join(",")}]`;
	}
	if (value && typeof value === "object") {
		return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
	}
	return JSON.stringify(value);
}
