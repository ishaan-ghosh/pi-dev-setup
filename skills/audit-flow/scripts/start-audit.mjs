#!/usr/bin/env node

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { captureTargetSnapshot, revalidateTargetSnapshot, sha256 } from "./audit-target.mjs";

const execFileAsync = promisify(execFile);
const DEFAULT_AUDIT_CONFIG_ROOT = fileURLToPath(new URL("../defaults", import.meta.url));
const NEUTRAL_AUDIT_CONFIG_PATH = ".audit";
const NEUTRAL_AUDIT_ARTIFACT_PATH = ".audit/local/audits";
const NEUTRAL_OVERRIDE_PATH = ".audit/local/audit.overrides.yaml";
const LEGACY_AUDIT_CONFIG_PATH = ".pi/audit";
const LEGACY_AUDIT_ARTIFACT_PATH = ".pi/local/audits";
const LEGACY_OVERRIDE_PATH = ".pi/local/audit.overrides.yaml";
const CONFINED_FRAGMENT_SOURCES = new Set(["repo-neutral", "repo-legacy", "default"]);
const STANDARD_AUDIT_ARTIFACT_NAMES = [
	"audit.yml",
	"primary-reviewer-prompt.md",
	"primary-initial.md",
	"primary-findings.json",
	"peer-review-prompt.md",
	"peer-review.md",
	"final-diff-reviewer-prompt.md",
	"final-diff-review.md",
	"synthesis.md",
	"findings.json",
	"final-human-reviewed.md",
	"final-plan.md",
	"receipt.md",
];
const RESERVED_YAML_MAPPING_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export async function startAudit(options) {
	const normalizedOptions = normalizeAuditRequest(options);
	if (normalizedOptions.allowUnignoredArtifacts) {
		throw new Error("--allow-unignored-artifacts is incompatible with immutable target snapshots; use an ignored artifact root.");
	}
	const requestedProjectRoot = resolve(normalizedOptions.projectRoot ?? process.cwd());
	const projectRoot = await canonicalizeExistingPath(requestedProjectRoot);
	const auditConfigRoots = resolveAuditConfigRoots(projectRoot, normalizedOptions.auditConfigRoot);
	const profileResolution = await resolveProfilePath(projectRoot, auditConfigRoots, normalizedOptions.profile);
	const profilePath = profileResolution.path;
	await assertNoSymlinkComponents(profilePath, "Audit profile path");
	const rawProfile = await readFile(profilePath, "utf8");
	let profile = parseYamlSubset(rawProfile);
	const localOverrides = await readLocalOverrides(projectRoot);
	profile = applyLocalOverrides(profile, localOverrides.value, normalizedOptions.env ?? process.env);
	profile = expandEnvPlaceholders(profile, normalizedOptions.env ?? process.env);

	const profileName = String(profile.name ?? normalizedOptions.profile);
	const auditType = String(profile.type ?? profileName);
	const target = String(normalizedOptions.target ?? "current worktree");
	const auditId = String(
		normalizedOptions.auditId ?? makeAuditId(normalizedOptions.now ?? new Date(), auditType, target),
	);
	validateAuditId(auditId);
	const artifactResolution = await resolveArtifactRoot(projectRoot, profile, normalizedOptions.artifactRoot);
	const artifactRoot = artifactResolution.path;
	const auditDir = join(artifactRoot, auditId);
	const fragments = await readFragments(profileResolution.root, profile.fragments ?? [], profileResolution.source);
	await ensureArtifactPathSafe(projectRoot, auditDir, STANDARD_AUDIT_ARTIFACT_NAMES);
	const targetSnapshot = await captureTargetSnapshot({
		projectRoot,
		profile,
		baseRef: normalizedOptions.baseRef,
		headRef: normalizedOptions.headRef,
	});
	const artifactNames = {
		auditYml: "audit.yml",
		primaryPrompt: "primary-reviewer-prompt.md",
		primaryInitial: "primary-initial.md",
		primaryFindings: "primary-findings.json",
		peerPrompt: "peer-review-prompt.md",
		peerReview: "peer-review.md",
		finalDiffPrompt: "final-diff-reviewer-prompt.md",
		finalDiffReview: "final-diff-review.md",
		findings: "findings.json",
		receipt: "receipt.md",
	};

	const dispatchIdFactory = normalizedOptions.dispatchIdFactory ?? randomUUID;
	const metadata = {
		id: auditId,
		type: auditType,
		status: "in_progress",
		created_at: (normalizedOptions.now ?? new Date()).toISOString(),
		updated_at: (normalizedOptions.now ?? new Date()).toISOString(),
		target: {
			raw: target,
			...targetSnapshot,
		},
		profile: {
			name: profileName,
			path: relativeFrom(projectRoot, profilePath),
			source: profileResolution.source,
			config_root: relativeFrom(projectRoot, profileResolution.root),
			description: profile.description ?? null,
			fragments: fragments.map((fragment) => fragment.profilePath),
			peer_fragments: profileResolution.source === "default"
				? fragments.map((fragment) => fragment.profilePath)
				: [],
			local_overrides: localOverrides.paths,
			local_override_source: localOverrides.source,
			platform: profile.platform ?? null,
			repos: profile.repos ?? null,
		},
		reviewers: {
			primary: {
				role: "primary-reviewer",
				dispatch_id: dispatchIdFactory(),
				tool: null,
				model: null,
				session_id: null,
				prompt: artifactNames.primaryPrompt,
				artifact: artifactNames.primaryInitial,
				findings: artifactNames.primaryFindings,
				report_sha256: null,
				completed_at: null,
			},
			peer: {
				role: "peer-reviewer",
				dispatch_id: dispatchIdFactory(),
				tool: null,
				model: null,
				session_id: null,
				prompt: artifactNames.peerPrompt,
				artifact: artifactNames.peerReview,
				report_sha256: null,
				completed_at: null,
			},
			final_diff: {
				role: "final-diff-reviewer",
				dispatch_id: dispatchIdFactory(),
				tool: null,
				model: null,
				session_id: null,
				prompt: artifactNames.finalDiffPrompt,
				artifact: artifactNames.finalDiffReview,
				report_sha256: null,
				completed_at: null,
			},
		},
		artifacts: {
			root: auditDir,
			root_source: artifactResolution.source,
			primary_prompt: artifactNames.primaryPrompt,
			primary_initial: artifactNames.primaryInitial,
			primary_findings: artifactNames.primaryFindings,
			peer_review_prompt: artifactNames.peerPrompt,
			peer_review: artifactNames.peerReview,
			final_diff_prompt: artifactNames.finalDiffPrompt,
			final_diff_review: artifactNames.finalDiffReview,
			findings: artifactNames.findings,
			receipt: artifactNames.receipt,
		},
	};

	assertUniqueDispatchIds(metadata.reviewers);
	const primaryPrompt = buildPrimaryPrompt({ auditId, target, metadata, fragments });
	const peerPrompt = buildPeerPrompt({
		auditId,
		target,
		metadata,
		fragments: profileResolution.source === "default" ? fragments : [],
	});
	const finalDiffPrompt = buildFinalDiffPrompt({ auditId, target, metadata, fragments });
	metadata.reviewers.primary.prompt_sha256 = sha256(primaryPrompt);
	metadata.reviewers.peer.prompt_sha256 = sha256(peerPrompt);
	metadata.reviewers.final_diff.prompt_sha256 = sha256(finalDiffPrompt);

	const auditYmlPath = join(auditDir, artifactNames.auditYml);
	const primaryPromptPath = join(auditDir, artifactNames.primaryPrompt);
	const peerPromptPath = join(auditDir, artifactNames.peerPrompt);
	const finalDiffPromptPath = join(auditDir, artifactNames.finalDiffPrompt);

	await revalidateTargetSnapshot(metadata.target);
	await mkdir(artifactRoot, { recursive: true });
	try {
		await mkdir(auditDir);
	} catch (error) {
		if (error?.code === "EEXIST") {
			throw new Error(`Audit directory already exists; choose a new audit id: ${auditDir}`);
		}
		throw error;
	}
	await writeFile(primaryPromptPath, primaryPrompt, { encoding: "utf8", flag: "wx" });
	await writeFile(peerPromptPath, peerPrompt, { encoding: "utf8", flag: "wx" });
	await writeFile(finalDiffPromptPath, finalDiffPrompt, { encoding: "utf8", flag: "wx" });
	await atomicWriteFile(auditYmlPath, toYaml(metadata), { refuseExisting: true });
	await revalidateTargetSnapshot(metadata.target);

	return {
		auditId,
		auditDir,
		auditYmlPath,
		primaryPromptPath,
		peerPromptPath,
		finalDiffPromptPath,
		primaryInitialPath: join(auditDir, artifactNames.primaryInitial),
		primaryFindingsPath: join(auditDir, artifactNames.primaryFindings),
		peerReviewPath: join(auditDir, artifactNames.peerReview),
		finalDiffReviewPath: join(auditDir, artifactNames.finalDiffReview),
		findingsPath: join(auditDir, artifactNames.findings),
		receiptPath: join(auditDir, artifactNames.receipt),
		artifactRoot,
		artifactRootSource: artifactResolution.source,
	};
}

function normalizeAuditRequest(options) {
	const command = options.profile;
	const aliases = {
		diff: { profile: "commit", target: "diff" },
		staged: { profile: "commit", target: "staged diff" },
		commit: { profile: "commit", target: "commit audit" },
		pr: { profile: "pr", target: "pull request audit" },
		stack: { profile: "pr", target: "stack audit" },
	};

	if (command && aliases[command]) {
		return {
			...options,
			profile: aliases[command].profile,
			target: options.target ?? aliases[command].target,
		};
	}
	return options;
}

function resolveAuditConfigRoots(projectRoot, explicitAuditConfigRoot) {
	if (explicitAuditConfigRoot) {
		return [
			{
				root: resolve(projectRoot, explicitAuditConfigRoot),
				source: "explicit-config-root",
			},
		];
	}

	return [
		{ root: resolve(projectRoot, NEUTRAL_AUDIT_CONFIG_PATH), source: "repo-neutral" },
		{ root: resolve(projectRoot, LEGACY_AUDIT_CONFIG_PATH), source: "repo-legacy" },
	];
}

async function resolveProfilePath(projectRoot, auditConfigRoots, profile) {
	if (!profile) {
		throw new Error("Missing audit profile. Pass --profile <name> or a positional profile name.");
	}

	const directPath = isAbsolute(profile) ? resolve(profile) : resolve(projectRoot, profile);
	if (await fileExists(directPath)) {
		return { path: directPath, root: inferAuditConfigRoot(directPath), source: "direct" };
	}

	const profileFile = profile.endsWith(".yaml") || profile.endsWith(".yml") ? profile : `${profile}.yaml`;
	const attemptedRepoPaths = [];
	for (const candidate of auditConfigRoots) {
		const repoProfilePath = resolve(candidate.root, "profiles", profileFile);
		attemptedRepoPaths.push(repoProfilePath);
		if (await fileExists(repoProfilePath)) {
			return { path: repoProfilePath, root: candidate.root, source: candidate.source };
		}
	}

	const defaultProfilePath = resolve(DEFAULT_AUDIT_CONFIG_ROOT, "profiles", profileFile);
	if (await fileExists(defaultProfilePath)) {
		return { path: defaultProfilePath, root: DEFAULT_AUDIT_CONFIG_ROOT, source: "default" };
	}

	throw new Error(
		`Audit profile not found: ${profile} (looked in ${[...attemptedRepoPaths, defaultProfilePath].join(", ")})`,
	);
}

function inferAuditConfigRoot(profilePath) {
	const parent = dirname(profilePath);
	return basename(parent) === "profiles" ? dirname(parent) : parent;
}

async function resolveArtifactRoot(projectRoot, profile, explicitArtifactRoot) {
	if (explicitArtifactRoot) {
		return {
			path: isAbsolute(explicitArtifactRoot) ? resolve(explicitArtifactRoot) : resolve(projectRoot, explicitArtifactRoot),
			source: "cli",
		};
	}

	const artifactBase = resolveArtifactBase(projectRoot, profile);
	const configuredPath = profile.artifact_root?.path;
	if (configuredPath) {
		return {
			path: isAbsolute(configuredPath) ? resolve(configuredPath) : resolve(artifactBase, configuredPath),
			source: "profile",
		};
	}

	const prefersNeutralRoot = await directoryExists(resolve(projectRoot, NEUTRAL_AUDIT_CONFIG_PATH));
	return {
		path: resolve(artifactBase, prefersNeutralRoot ? NEUTRAL_AUDIT_ARTIFACT_PATH : LEGACY_AUDIT_ARTIFACT_PATH),
		source: prefersNeutralRoot ? "neutral-default" : "legacy-fallback",
	};
}

function resolveArtifactBase(projectRoot, profile) {
	const artifactRepoName = profile.artifact_root?.repo;
	if (!artifactRepoName) {
		return projectRoot;
	}

	const repo = Array.isArray(profile.repos) ? profile.repos.find((candidate) => candidate.name === artifactRepoName) : null;
	if (!repo) {
		throw new Error(`Profile artifact_root.repo references unknown repo: ${artifactRepoName}`);
	}

	const contextRoot = profile.platform?.context_root;
	const platformRoot = contextRoot ? (isAbsolute(contextRoot) ? contextRoot : resolve(projectRoot, contextRoot)) : projectRoot;
	return isAbsolute(repo.path) ? repo.path : resolve(platformRoot, repo.path);
}

async function readFragments(auditConfigRoot, fragmentPaths, profileSource) {
	if (!Array.isArray(fragmentPaths)) {
		throw new Error("Profile `fragments` must be a list.");
	}

	const confined = CONFINED_FRAGMENT_SOURCES.has(profileSource);
	const canonicalConfigRoot = confined ? await realpath(auditConfigRoot) : null;
	const fragments = [];
	for (const fragmentPath of fragmentPaths) {
		const profilePath = String(fragmentPath);
		if (confined && isAbsolute(profilePath)) {
			throw new Error(`A repository-controlled fragment must remain inside its audit config root: ${profilePath}`);
		}
		const absolutePath = isAbsolute(profilePath) ? resolve(profilePath) : resolve(auditConfigRoot, profilePath);
		if (confined) assertPathInside(canonicalConfigRoot, absolutePath, profilePath);
		await assertNoSymlinkComponents(absolutePath, `Audit prompt fragment path (${profilePath})`);
		if (confined) assertPathInside(canonicalConfigRoot, await realpath(absolutePath), profilePath);
		const contents = await readFile(absolutePath, "utf8");
		fragments.push({ profilePath, absolutePath, contents });
	}
	return fragments;
}

function assertPathInside(root, candidate, displayPath) {
	const relativePath = relative(root, candidate);
	if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
		throw new Error(`A repository-controlled fragment must remain inside its audit config root: ${displayPath}`);
	}
}

function buildPrimaryPrompt({ auditId, target, metadata, fragments }) {
	return [
		`# Primary audit prompt`,
		``,
		`You are the primary-reviewer for audit \`${auditId}\`.`,
		`Dispatch ID: \`${metadata.reviewers.primary.dispatch_id}\``,
		``,
		`Target: ${target}`,
		formatTargetBinding(metadata.target),
		``,
		`Do not edit application code. You may run safe targeted read-only or validation commands when useful. Ask before expensive, stateful, hardware, network-mutating, or destructive commands.`,
		``,
		`Inspect the target directly. Produce findings first, ordered by severity, with exact file/line references for confirmed findings. Distinguish confirmed findings, open questions/assumptions, optional suggestions, and residual risks.`,
		``,
		`If you are running as a delegated reviewer, return the audit report as your final answer so the parent can save it to \`primary-initial.md\`. Include a structured candidate findings section compatible with FINDINGS-SCHEMA.md when practical.`,
		``,
		formatFragments(fragments),
		``,
	].join("\n");
}

function buildPeerPrompt({ auditId, target, metadata, fragments }) {
	assertPeerFragmentSafety(fragments, metadata);
	const prompt = [
		`# Peer-review prompt`,
		``,
		`You are the peer-reviewer for audit \`${auditId}\`.`,
		`Dispatch ID: \`${metadata.reviewers.peer.dispatch_id}\``,
		``,
		`Target: ${target}`,
		formatTargetBinding(metadata.target),
		``,
		`This is a blind, independent raw-target review. Do not inspect audit metadata or any other reviewer's prompt, report, findings, or synthesis. Do not ask for another reviewer's output before recording your own report.`,
		``,
		`Do not edit application code. Inspect the immutable target directly and independently. Challenge the implementation adversarially and identify concrete defects with evidence.`,
		``,
		`Return a self-contained raw-target report that can be saved as \`peer-review.md\`. Do not critique or refer to unseen reviewer output. Later comparison or critique, if desired, must use a separate prompt and artifact after this report is recorded. This stage has reviewer key peer and role peer-reviewer; findings must cite the concrete key.`,
		``,
		formatFragments(fragments),
		``,
	].join("\n");
	return prompt;
}

function assertPeerFragmentSafety(fragments, metadata) {
	const forbiddenReferences = [
		"audit.yml",
		metadata.reviewers.primary.prompt,
		metadata.reviewers.primary.artifact,
		metadata.reviewers.primary.findings,
		metadata.reviewers.final_diff.prompt,
		metadata.reviewers.final_diff.artifact,
		metadata.artifacts.findings,
		metadata.artifacts.receipt,
		"synthesis.md",
		"final-human-reviewed.md",
		"final-plan.md",
		"github-review-packet.md",
		"github-review-comments.json",
		"peer-github-review-prompt.md",
		".audit/local/audits",
		".pi/local/audits",
	].filter(Boolean).map((value) => String(value).toLowerCase());
	for (const fragment of fragments) {
		const candidate = `${fragment.profilePath}\n${fragment.contents}`.toLowerCase();
		const disclosed = forbiddenReferences.find((reference) => candidate.includes(reference));
		if (disclosed) {
			throw new Error(`Peer prompt fragment ${fragment.profilePath} references private audit artifact ${disclosed}; keep the raw-target peer dispatch blind.`);
		}
	}
}

function buildFinalDiffPrompt({ auditId, target, metadata, fragments }) {
	return [
		`# Final-diff adversarial prompt`,
		``,
		`You are the final-diff-reviewer for audit \`${auditId}\`.`,
		`Dispatch ID: \`${metadata.reviewers.final_diff.dispatch_id}\``,
		``,
		`Target: ${target}`,
		formatTargetBinding(metadata.target),
		``,
		`Do not edit application code. Adversarially audit the entire final target diff as a shipping unit. Look for incorrect fixes, integration regressions, missing tests, and target-wide issues that finding-level verification could miss.`,
		``,
		`This is the mandatory final-diff gate, not a focused verification of earlier findings. Inspect the target directly and return a self-contained report for \`final-diff-review.md\`. Do not treat finding-verifier reports as a substitute for this review.`,
		``,
		formatFragments(fragments),
		``,
	].join("\n");
}

function formatTargetBinding(target) {
	const repos = target.repos
		.map((repo) => `- ${JSON.stringify({
			capture: {
				name: repo.name,
				role: repo.role,
				path: repo.root,
				base_ref: repo.base_ref,
				head_ref: repo.head_ref,
			},
			resolved: {
				base_oid: repo.base_oid,
				head_oid: repo.head_oid,
				staged_diff_sha256: repo.staged_diff_sha256,
				unstaged_diff_sha256: repo.unstaged_diff_sha256,
				tracked_manifest_sha256: repo.tracked_manifest_sha256,
				tracked_count: repo.tracked.length,
				untracked_manifest_sha256: repo.untracked_manifest_sha256,
				untracked_count: repo.untracked.length,
				snapshot_sha256: repo.snapshot_sha256,
			},
		})}`)
		.join("\n");
	return [
		`Target snapshot schema: \`${target.snapshot_schema}\``,
		`Aggregate snapshot SHA-256: \`${target.snapshot_sha256}\``,
		`Repository snapshot records (ordered; JSON after each \`- \` is machine-readable):`,
		repos,
		`Use each capture record with the raw repository to reproduce its resolved digests and the ordered aggregate. Full tracked and untracked manifests are intentionally omitted from this compact prompt.`,
		`Review exactly this snapshot. Stop and report target drift if any recorded ref, diff, tracked path, or untracked path no longer matches.`,
	].join("\n");
}

function formatFragments(fragments) {
	return fragments
		.map((fragment) => [`## Fragment: ${fragment.profilePath}`, ``, fragment.contents.trimEnd()].join("\n"))
		.join("\n\n");
}

async function ensureArtifactPathSafe(projectRoot, auditDir, plannedArtifactNames) {
	await assertNoSymlinkComponents(auditDir);

	const gitProbeCwd = await nearestExistingAncestor(auditDir, projectRoot);
	const topLevel = await gitOutput(gitProbeCwd, "rev-parse", "--show-toplevel");
	if (!topLevel) {
		return;
	}

	const relativeAuditDir = relative(topLevel, auditDir);
	if (relativeAuditDir === ".." || relativeAuditDir.startsWith(`..${sep}`) || isAbsolute(relativeAuditDir)) {
		return;
	}

	const candidates = [
		...plannedArtifactNames,
		`verification-${randomUUID()}.md`,
		`verification-${randomUUID()}-prompt.md`,
	];
	for (const artifactName of candidates) {
		const relativeArtifactPath = relative(topLevel, join(auditDir, artifactName));
		try {
			await execFileAsync("git", ["check-ignore", "--quiet", "--no-index", "--", relativeArtifactPath], { cwd: topLevel });
		} catch {
			throw new Error(
				`Artifact path is inside a git repository but is not ignored; planned artifact is not ignored: ${artifactName} under ${auditDir}. Add .audit/local/ to .gitignore or .git/info/exclude (legacy repositories may keep .pi/local/), or choose an ignored --artifact-root.`,
			);
		}
	}
	try {
		await execFileAsync("git", ["check-ignore", "--quiet", "--no-index", "--", relativeAuditDir], { cwd: topLevel });
	} catch {
		throw new Error(
			`Artifact directory itself must be ignored so every future audit artifact remains outside the target snapshot: ${auditDir}. Ignore .audit/local/ or the complete audit directory (legacy repositories may use .pi/local/).`,
		);
	}
}

export async function assertNoSymlinkComponents(filePath, label = "Path") {
	const components = [];
	let current = resolve(filePath);
	while (current !== dirname(current)) {
		components.push(current);
		current = dirname(current);
	}

	for (const component of components.reverse()) {
		try {
			const componentStat = await lstat(component);
			if (componentStat.isSymbolicLink()) {
				throw new Error(`${label} contains a symbolic-link component: ${component}`);
			}
		} catch (error) {
			if (error?.code === "ENOENT") {
				continue;
			}
			throw error;
		}
	}
}

async function nearestExistingAncestor(filePath, fallbackPath) {
	let current = filePath;
	while (current && current !== dirname(current)) {
		if (await fileExists(current)) {
			return current;
		}
		current = dirname(current);
	}
	return fallbackPath;
}

async function gitOutput(projectRoot, ...args) {
	try {
		const { stdout } = await execFileAsync("git", args, { cwd: projectRoot });
		return stdout.trim();
	} catch {
		return null;
	}
}

async function readLocalOverrides(projectRoot) {
	for (const overridePath of [NEUTRAL_OVERRIDE_PATH, LEGACY_OVERRIDE_PATH]) {
		const absolutePath = join(projectRoot, overridePath);
		if (await fileExists(absolutePath)) {
			await assertNoSymlinkComponents(absolutePath, "Audit local override path");
			return {
				value: parseYamlSubset(await readFile(absolutePath, "utf8")),
				paths: [overridePath],
				source: overridePath === NEUTRAL_OVERRIDE_PATH ? "neutral" : "legacy",
			};
		}
	}
	return { value: null, paths: [], source: null };
}

function applyLocalOverrides(profile, overrides, env) {
	const nextProfile = structuredClone(profile);
	const platformName = nextProfile.platform?.name;
	const platformOverride = platformName ? overrides?.platforms?.[platformName] : null;
	if (platformOverride?.context_root) {
		nextProfile.platform = {
			...nextProfile.platform,
			context_root: platformOverride.context_root,
		};
	}
	return expandEnvPlaceholders(nextProfile, env);
}

function expandEnvPlaceholders(value, env) {
	if (Array.isArray(value)) {
		return value.map((item) => expandEnvPlaceholders(item, env));
	}
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expandEnvPlaceholders(item, env)]));
	}
	if (typeof value !== "string") {
		return value;
	}
	return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?}/g, (_match, name, fallback) => {
		const envValue = env[name];
		if (envValue !== undefined && envValue !== "") {
			return envValue;
		}
		return fallback ?? "";
	});
}

export function parseYamlSubset(text) {
	const root = {};
	const stack = [{ indent: -1, type: "object", value: root }];

	for (const rawLine of text.split(/\r?\n/)) {
		const line = stripInlineComment(rawLine);
		if (!line.trim()) {
			continue;
		}

		const indent = countIndent(line);
		const content = line.trim();

		while (stack.length > 1 && indent <= stack.at(-1).indent) {
			stack.pop();
		}

		let parent = stack.at(-1);
		if (parent.type === "pending") {
			const container = content === "-" || content.startsWith("- ") ? [] : {};
			parent.owner[parent.key] = container;
			parent.type = Array.isArray(container) ? "array" : "object";
			parent.value = container;
		}

		parent = stack.at(-1);
		if (content === "-" || content.startsWith("- ")) {
			if (parent.type !== "array") {
				throw new Error(`Invalid YAML subset: list item without list parent: ${rawLine}`);
			}
			const itemText = content === "-" ? "" : content.slice(2).trim();
			if (itemText === "") {
				const item = {};
				parent.value.push(item);
				stack.push({ indent, type: "object", value: item });
			} else if (looksLikeKeyValue(itemText)) {
				const item = {};
				parent.value.push(item);
				const { key, rawValue } = splitKeyValue(itemText);
				if (rawValue === "") {
					stack.push({ indent, type: "object", value: item });
					stack.push({ indent, type: "pending", owner: item, key });
				} else {
					item[key] = parseScalar(rawValue);
					stack.push({ indent, type: "object", value: item });
				}
			} else {
				parent.value.push(parseScalar(itemText));
			}
			continue;
		}

		if (parent.type !== "object") {
			throw new Error(`Invalid YAML subset: key/value without object parent: ${rawLine}`);
		}

		const { key, rawValue } = splitKeyValue(content);
		if (rawValue === "") {
			stack.push({ indent, type: "pending", owner: parent.value, key });
		} else {
			parent.value[key] = parseScalar(rawValue);
		}
	}

	return root;
}

function stripInlineComment(line) {
	let inSingleQuote = false;
	let inDoubleQuote = false;
	for (let i = 0; i < line.length; i += 1) {
		const char = line[i];
		if (inDoubleQuote && char === "\\") {
			i += 1;
			continue;
		}
		if (char === "'" && !inDoubleQuote) inSingleQuote = !inSingleQuote;
		if (char === '"' && !inSingleQuote) inDoubleQuote = !inDoubleQuote;
		if (char === "#" && !inSingleQuote && !inDoubleQuote && (i === 0 || /\s/.test(line[i - 1]))) {
			return line.slice(0, i).trimEnd();
		}
	}
	return line;
}

function countIndent(line) {
	let count = 0;
	for (const char of line) {
		if (char === " ") count += 1;
		else break;
	}
	return count;
}

function looksLikeKeyValue(text) {
	return /^[A-Za-z0-9_-]+\s*:/.test(text);
}

function splitKeyValue(text) {
	const match = text.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
	if (!match) {
		throw new Error(`Invalid YAML subset line: ${text}`);
	}
	const key = match[1];
	if (RESERVED_YAML_MAPPING_KEYS.has(key)) {
		throw new Error(`Invalid YAML subset: reserved YAML mapping key is not allowed: ${key}`);
	}
	return { key, rawValue: match[2] };
}

function parseScalar(value) {
	const trimmed = value.trim();
	if (trimmed === "null" || trimmed === "~") return null;
	if (trimmed === "[]") return [];
	if (trimmed === "true") return true;
	if (trimmed === "false") return false;
	if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
	if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
		try {
			return JSON.parse(trimmed);
		} catch {
			return trimmed.slice(1, -1);
		}
	}
	if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

export function toYaml(value, indent = 0) {
	const pad = " ".repeat(indent);
	if (Array.isArray(value)) {
		if (value.length === 0) return "[]\n";
		return value
			.map((item) => {
				if (item && typeof item === "object") {
					return `${pad}-\n${toYaml(item, indent + 2)}`;
				}
				return `${pad}- ${formatScalar(item)}\n`;
			})
			.join("");
	}
	if (value && typeof value === "object") {
		return Object.entries(value)
			.map(([key, item]) => {
				if (Array.isArray(item)) {
					return item.length === 0 ? `${pad}${key}: []\n` : `${pad}${key}:\n${toYaml(item, indent + 2)}`;
				}
				if (item && typeof item === "object") {
					return `${pad}${key}:\n${toYaml(item, indent + 2)}`;
				}
				return `${pad}${key}: ${formatScalar(item)}\n`;
			})
			.join("");
	}
	return `${pad}${formatScalar(value)}\n`;
}

export async function atomicWriteFile(filePath, contents, options = {}) {
	const targetPath = resolve(filePath);
	if (options.refuseExisting && await fileExists(targetPath)) {
		throw new Error(`Refusing to overwrite existing file: ${targetPath}`);
	}
	const temporaryPath = join(dirname(targetPath), `.${basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`);
	let handle;
	try {
		handle = await open(temporaryPath, "wx", 0o600);
		await handle.writeFile(contents, "utf8");
		await handle.sync();
		await handle.close();
		handle = null;
		await rename(temporaryPath, targetPath);
	} catch (error) {
		await handle?.close().catch(() => {});
		await unlink(temporaryPath).catch(() => {});
		throw error;
	}
}

export async function withAuditMetadataLock(auditYmlPath, callback, options = {}) {
	const lockPath = `${resolve(auditYmlPath)}.lock`;
	const timeoutMs = options.timeoutMs ?? 5000;
	const startedAt = Date.now();
	let lock;
	while (!lock) {
		try {
			lock = await open(lockPath, "wx", 0o600);
		} catch (error) {
			if (error?.code !== "EEXIST") throw error;
			if (Date.now() - startedAt >= timeoutMs) {
				throw new Error(`Timed out waiting for serialized audit metadata update: ${lockPath}`);
			}
			await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
		}
	}

	try {
		await lock.writeFile(`${process.pid}\n`, "utf8");
		await lock.sync();
		return await callback();
	} finally {
		await lock.close().catch(() => {});
		await unlink(lockPath).catch(() => {});
	}
}

export function assertUniqueDispatchIds(reviewers) {
	const dispatchIds = [];
	for (const [key, reviewer] of Object.entries(reviewers ?? {})) {
		if (!reviewer?.dispatch_id) {
			throw new Error(`Reviewer ${key} is missing a dispatch_id.`);
		}
		dispatchIds.push(String(reviewer.dispatch_id));
	}
	if (new Set(dispatchIds).size !== dispatchIds.length) {
		throw new Error("Reviewer dispatch IDs must be distinct within an audit.");
	}
}

function formatScalar(value) {
	if (value === null || value === undefined) return "null";
	if (typeof value === "boolean" || typeof value === "number") return String(value);
	return JSON.stringify(String(value));
}

function makeAuditId(now, type, target) {
	const timestamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z").replace("T", "-");
	const slug = `${type}-${target}`
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80);
	return `${timestamp}-${slug || "audit"}`;
}

function validateAuditId(auditId) {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(auditId) || auditId === "." || auditId === "..") {
		throw new Error(`Invalid audit id: ${auditId}. Use letters, numbers, dots, underscores, and hyphens only.`);
	}
}

function relativeFrom(root, filePath) {
	const relativePath = relative(root, filePath);
	if (!relativePath) return ".";
	if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
		return filePath;
	}
	return relativePath;
}

async function fileExists(filePath) {
	try {
		await stat(filePath);
		return true;
	} catch {
		return false;
	}
}

async function directoryExists(filePath) {
	try {
		return (await stat(filePath)).isDirectory();
	} catch {
		return false;
	}
}

async function canonicalizeExistingPath(filePath) {
	try {
		return await realpath(filePath);
	} catch {
		return filePath;
	}
}

function parseArgs(argv) {
	const options = {};
	const positional = [];
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--profile") options.profile = argv[++i];
		else if (arg === "--target") options.target = argv[++i];
		else if (arg === "--project-root") options.projectRoot = argv[++i];
		else if (arg === "--audit-config-root") options.auditConfigRoot = argv[++i];
		else if (arg === "--audit-id") options.auditId = argv[++i];
		else if (arg === "--artifact-root") options.artifactRoot = argv[++i];
		else if (arg === "--base") options.baseRef = argv[++i];
		else if (arg === "--head") options.headRef = argv[++i];
		else if (arg === "--allow-unignored-artifacts") options.allowUnignoredArtifacts = true;
		else if (arg === "--help" || arg === "-h") options.help = true;
		else positional.push(arg);
	}

	if (!options.profile && positional.length > 0) {
		options.profile = positional.shift();
	}
	if (!options.target && positional.length > 0) {
		options.target = positional.join(" ");
	}
	return options;
}

function usage() {
	return `Usage: node scripts/start-audit.mjs --profile <profile> [--target <target>] [--project-root <path>] [--base <ref>] [--head <ref>]\n\nExamples:\n  node scripts/start-audit.mjs --profile pr --target "PR #14" --base origin/main --head HEAD\n  node scripts/start-audit.mjs diff\n  node scripts/start-audit.mjs commit "staged diff"\n\nRepo-local profiles are resolved from .audit/ first, then legacy .pi/audit/. By default, artifacts use .audit/local/audits when .audit/ exists and legacy .pi/local/audits otherwise. Artifact paths inside audited git repositories must be ignored so generated audit files cannot change the immutable target snapshot.\n`;
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		console.log(usage());
		return;
	}
	const result = await startAudit(options);
	console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
