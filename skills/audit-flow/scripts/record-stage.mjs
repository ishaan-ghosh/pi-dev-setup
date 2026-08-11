#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { revalidateTargetSnapshot, sha256 } from "./audit-target.mjs";
import {
	assertNoSymlinkComponents,
	assertUniqueDispatchIds,
	atomicWriteFile,
	parseYamlSubset,
	toYaml,
	withAuditMetadataLock,
} from "./start-audit.mjs";

const STAGE_CONFIG = {
	primary: {
		reviewerKey: "primary",
		artifactKey: "primary_initial",
		defaultArtifact: "primary-initial.md",
		role: "primary-reviewer",
	},
	peer: {
		reviewerKey: "peer",
		artifactKey: "peer_review",
		defaultArtifact: "peer-review.md",
		role: "peer-reviewer",
	},
	"final-diff": {
		reviewerKey: "final_diff",
		artifactKey: "final_diff_review",
		defaultArtifact: "final-diff-review.md",
		role: "final-diff-reviewer",
	},
	verification: {
		reviewerKey: null,
		artifactKey: null,
		defaultArtifact: null,
		role: "finding-verifier",
	},
};
const RESERVED_YAML_MAPPING_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export async function recordAuditStage(options) {
	const auditYmlPath = resolveAuditYmlPath(options);
	const stage = options.stage ?? "primary";
	const config = STAGE_CONFIG[stage];
	if (!config) {
		throw new Error(`Unsupported audit stage: ${stage}. Expected one of: ${Object.keys(STAGE_CONFIG).join(", ")}`);
	}
	const reviewerKey = resolveReviewerKey(stage, config, options.reviewerKey);
	const artifactKey = config.artifactKey ?? reviewerKey.replaceAll("-", "_");
	const promptArtifactKey = `${artifactKey}_prompt`;

	await assertNoSymlinkComponents(auditYmlPath, "Audit metadata path");
	return withAuditMetadataLock(auditYmlPath, async () => {
		const audit = parseYamlSubset(await readFile(auditYmlPath, "utf8"));
		const metadataDir = dirname(auditYmlPath);
		const declaredAuditRoot = audit.artifacts?.root ? String(audit.artifacts.root) : metadataDir;
		const auditDir = resolveDeclaredAuditRoot(metadataDir, declaredAuditRoot);
		if (auditDir !== metadataDir || resolve(auditYmlPath) !== join(metadataDir, "audit.yml")) {
			throw new Error(`Audit metadata path does not match its declared artifact root: ${auditYmlPath}`);
		}
		if ((audit.status ?? "in_progress") !== "in_progress") {
			throw new Error(`Audit is already finalized with status ${audit.status}; reviewer stages are immutable.`);
		}
		await assertNoSymlinkComponents(auditDir, "Audit directory");
		await revalidateTargetSnapshot(audit.target);
		audit.reviewers = audit.reviewers ?? {};
		audit.artifacts = audit.artifacts ?? { root: auditDir };
		let prerequisiteCompletionTimes = [];
		if (stage === "peer" || stage === "final-diff" || stage === "verification") {
			const prerequisites = stage === "peer" ? ["primary"] : ["primary", "peer"];
			for (const prerequisite of prerequisites) {
				const reviewer = audit.reviewers[prerequisite];
				const completedAt = reviewer?.completed_at;
				const completionTime = typeof completedAt === "string" ? Date.parse(completedAt) : Number.NaN;
				if (
					reviewer?.role !== STAGE_CONFIG[prerequisite]?.role ||
					!Number.isFinite(completionTime) ||
					!isSha256(reviewer?.report_sha256) ||
					!hasCompleteRecordedIdentity(audit, prerequisite, reviewer)
				) {
					throw new Error(`Cannot record ${stage} before the ${prerequisite} reviewer stage is completed.`);
				}
				prerequisiteCompletionTimes.push(completionTime);
			}
		}

		if (stage === "verification" && audit.reviewers[reviewerKey]) {
			throw new Error(`Verification reviewer key collision: ${reviewerKey} is already recorded.`);
		}
		if (stage === "verification" && audit.artifacts[artifactKey]) {
			throw new Error(`Verification artifact metadata key collision: ${artifactKey} is already recorded.`);
		}
		if (stage === "verification" && audit.artifacts[promptArtifactKey]) {
			throw new Error(`Verification prompt metadata key collision: ${promptArtifactKey} is already recorded.`);
		}
		const existingReviewer = audit.reviewers[reviewerKey];
		if (stage !== "verification" && (!existingReviewer || existingReviewer.role !== config.role)) {
			throw new Error(`Audit metadata is missing the dispatched ${config.role} reviewer.`);
		}
		if (existingReviewer?.completed_at || existingReviewer?.report_sha256) {
			throw new Error(`Refusing to overwrite recorded ${stage} reviewer output.`);
		}

		const metadataArtifact = audit.artifacts[artifactKey];
		const artifactPath = resolveArtifactPath(auditDir, options.artifactPath, metadataArtifact, config.defaultArtifact);
		assertInsideAuditDirectory(auditDir, artifactPath, `${stage} artifact`);
		await assertNoSymlinkComponents(artifactPath, `${stage} artifact path`);
		await assertFileExists(artifactPath, `${stage} artifact`);
		if (stage !== "verification" && metadataArtifact && relativeArtifact(auditDir, artifactPath) !== String(metadataArtifact)) {
			throw new Error(`${stage} artifact must match the dispatched metadata path: ${metadataArtifact}`);
		}
		if (stage === "verification" && !/^verification-[A-Za-z0-9._-]+\.md$/.test(basename(artifactPath))) {
			throw new Error("Verification artifact filename must match verification-<name>.md.");
		}

		const recordedArtifact = relativeArtifact(auditDir, artifactPath);
		if (
			stage === "verification" &&
			Object.entries(audit.artifacts).some(
				([key, value]) => key !== "root" && String(value) === recordedArtifact,
			)
		) {
			throw new Error(`Verification artifact is already recorded by another reviewer: ${recordedArtifact}`);
		}
		let verificationPromptPath = null;
		let recordedPrompt = null;
		let verificationPromptSha256 = null;
		if (stage === "verification") {
			verificationPromptPath = resolveArtifactPath(
				auditDir,
				options.promptPath,
				undefined,
				undefined,
				"verification prompt",
			);
			assertInsideAuditDirectory(auditDir, verificationPromptPath, "verification prompt");
			await assertNoSymlinkComponents(verificationPromptPath, "verification prompt path");
			await assertFileExists(verificationPromptPath, "verification prompt");
			if (!/^verification-[A-Za-z0-9._-]+-prompt\.md$/.test(basename(verificationPromptPath))) {
				throw new Error("Verification prompt filename must match verification-<name>-prompt.md.");
			}
			recordedPrompt = relativeArtifact(auditDir, verificationPromptPath);
			if (recordedPrompt === recordedArtifact) {
				throw new Error("Verification prompt and report must be different artifacts.");
			}
			if (Object.entries(audit.artifacts).some(([key, value]) => key !== "root" && String(value) === recordedPrompt)) {
				throw new Error(`Verification prompt is already recorded as another audit artifact: ${recordedPrompt}`);
			}
			const promptBuffer = await readFile(verificationPromptPath);
			if (promptBuffer.length === 0) {
				throw new Error("Verification prompt must not be empty.");
			}
			verificationPromptSha256 = sha256(promptBuffer);
		}

		const reviewer = existingReviewer ?? {
			role: config.role,
			dispatch_id: options.dispatchId ?? randomUUID(),
		};
		if (options.dispatchId !== undefined && reviewer.dispatch_id !== options.dispatchId) {
			throw new Error(`Dispatch ID does not match the dispatched ${stage} reviewer.`);
		}
		if (stage === "verification") {
			reviewer.prompt = recordedPrompt;
			reviewer.prompt_sha256 = verificationPromptSha256;
		} else if (!reviewer.prompt) {
			throw new Error(`Dispatched ${stage} reviewer is missing prompt metadata.`);
		}
		if (stage !== "verification") {
			await validatePromptDigest(auditDir, reviewer, stage);
		}
		const reportBuffer = await readFile(artifactPath);
		if (reportBuffer.length === 0) {
			throw new Error(`${stage} artifact must not be empty.`);
		}
		const tool = requireIdentity(options.tool ?? reviewer.tool, `${stage} tool`);
		const model = requireIdentity(options.model ?? reviewer.model, `${stage} model`);
		const sessionId = requireIdentity(options.sessionId ?? reviewer.session_id, `${stage} session ID`);
		const recordedAt = (options.now ?? new Date()).toISOString();
		const recordedTime = Date.parse(recordedAt);
		if (prerequisiteCompletionTimes.some((time) => recordedTime < time)) {
			const prerequisiteLabel = stage === "peer" ? "primary" : "primary or peer";
			throw new Error(`Cannot record ${stage} with a completion timestamp earlier than ${prerequisiteLabel}.`);
		}
		const reportSha256 = sha256(reportBuffer);
		reviewer.role = config.role;
		reviewer.tool = tool;
		reviewer.model = model;
		reviewer.session_id = sessionId;
		if (options.scope !== undefined) reviewer.scope = options.scope;
		reviewer.completed_at = recordedAt;
		reviewer.artifact = recordedArtifact;
		reviewer.report_sha256 = reportSha256;
		reviewer.attestation = {
			kind: "orchestrator-attested",
			audit_id: String(audit.id),
			reviewer_key: reviewerKey,
			dispatch_id: String(reviewer.dispatch_id),
			target_snapshot_sha256: String(audit.target.snapshot_sha256),
			prompt_sha256: reviewer.prompt_sha256 ?? null,
			artifact: recordedArtifact,
			report_sha256: reportSha256,
			recorded_at: recordedAt,
		};
		audit.reviewers[reviewerKey] = reviewer;
		audit.artifacts[artifactKey] = reviewer.artifact;
		if (stage === "verification") audit.artifacts[promptArtifactKey] = reviewer.prompt;
		assertUniqueDispatchIds(audit.reviewers);
		assertUniqueSessionIds(audit.reviewers);
		audit.updated_at = recordedAt;
		await atomicWriteFile(auditYmlPath, toYaml(audit));

		return {
			auditYmlPath,
			auditDir,
			stage,
			reviewerKey,
			artifactPath,
			promptPath: verificationPromptPath,
			dispatchId: reviewer.dispatch_id,
			reportSha256: reviewer.report_sha256,
		};
	}, { timeoutMs: options.lockTimeoutMs });
}

function isSha256(value) {
	return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function hasCompleteRecordedIdentity(audit, reviewerKey, reviewer) {
	if (![reviewer?.tool, reviewer?.model, reviewer?.session_id, reviewer?.dispatch_id, reviewer?.artifact, reviewer?.prompt]
		.every((value) => typeof value === "string" && value.trim() !== "")) {
		return false;
	}
	if (!isSha256(reviewer.prompt_sha256)) return false;
	const attestation = reviewer.attestation;
	return attestation?.kind === "orchestrator-attested" &&
		attestation.audit_id === String(audit.id) &&
		attestation.reviewer_key === reviewerKey &&
		attestation.dispatch_id === String(reviewer.dispatch_id) &&
		attestation.target_snapshot_sha256 === String(audit.target.snapshot_sha256) &&
		attestation.prompt_sha256 === reviewer.prompt_sha256 &&
		attestation.artifact === reviewer.artifact &&
		attestation.report_sha256 === reviewer.report_sha256 &&
		attestation.recorded_at === reviewer.completed_at;
}

function requireIdentity(value, label) {
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(`Recording a reviewer stage requires a nonempty ${label}.`);
	}
	return value.trim();
}

async function validatePromptDigest(auditDir, reviewer, stage) {
	if (!reviewer.prompt_sha256) {
		throw new Error(`Dispatched ${stage} reviewer is missing prompt_sha256 metadata.`);
	}
	const promptPath = resolveArtifactPath(auditDir, undefined, reviewer.prompt, undefined);
	assertInsideAuditDirectory(auditDir, promptPath, `${stage} prompt`);
	await assertNoSymlinkComponents(promptPath, `${stage} prompt path`);
	await assertFileExists(promptPath, `${stage} prompt`);
	const digest = sha256(await readFile(promptPath));
	if (digest !== reviewer.prompt_sha256) {
		throw new Error(`${stage} prompt changed after dispatch; refusing to record reviewer output.`);
	}
}

function assertUniqueSessionIds(reviewers) {
	const sessionIds = Object.values(reviewers)
		.map((reviewer) => reviewer?.session_id)
		.filter((value) => value !== null && value !== undefined && value !== "")
		.map(String);
	if (new Set(sessionIds).size !== sessionIds.length) {
		throw new Error("Reviewer session IDs, when supplied, must be distinct within an audit.");
	}
}

function assertInsideAuditDirectory(auditDir, candidatePath, label) {
	const relativePath = relative(auditDir, candidatePath);
	if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
		throw new Error(`${label} must be inside the selected audit directory: ${candidatePath}`);
	}
}

function resolveDeclaredAuditRoot(metadataDir, declaredAuditRoot) {
	if (isAbsolute(declaredAuditRoot)) {
		return resolve(declaredAuditRoot);
	}
	const normalizedRoot = normalize(declaredAuditRoot);
	const components = normalizedRoot.split(sep);
	if (components.includes("..")) {
		throw new Error(`Audit metadata declares an unsafe relative artifact root: ${declaredAuditRoot}`);
	}
	if (normalizedRoot === "." || metadataDir.endsWith(`${sep}${normalizedRoot}`)) {
		return metadataDir;
	}
	return resolve(declaredAuditRoot);
}

function resolveReviewerKey(stage, config, explicitReviewerKey) {
	if (stage === "verification" && !explicitReviewerKey) {
		throw new Error("Verification stages require --reviewer-key <key>.");
	}
	if (stage !== "verification" && explicitReviewerKey) {
		throw new Error(`--reviewer-key is only valid with --stage verification (received ${stage}).`);
	}
	const reviewerKey = explicitReviewerKey ?? config.reviewerKey;
	if (RESERVED_YAML_MAPPING_KEYS.has(reviewerKey)) {
		throw new Error(`Reviewer key is a reserved YAML mapping key: ${reviewerKey}`);
	}
	if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(reviewerKey)) {
		throw new Error("Reviewer key must start with a letter and contain only letters, numbers, underscores, or hyphens.");
	}
	return reviewerKey;
}

function resolveAuditYmlPath(options) {
	if (options.auditYmlPath) {
		return resolve(options.auditYmlPath);
	}
	if (options.auditDir) {
		return resolve(options.auditDir, "audit.yml");
	}
	throw new Error("Missing audit metadata path. Pass --audit-yml <path> or --audit-dir <path>.");
}

function resolveArtifactPath(auditDir, explicitArtifactPath, metadataArtifact, defaultArtifact, label = "verification artifact") {
	if (explicitArtifactPath) {
		return isAbsolute(explicitArtifactPath) ? explicitArtifactPath : resolve(auditDir, explicitArtifactPath);
	}
	const artifact = metadataArtifact ?? defaultArtifact;
	if (!artifact) {
		throw new Error(`Missing ${label}. Pass --${label === "verification prompt" ? "prompt" : "artifact"} <path>.`);
	}
	return isAbsolute(artifact) ? artifact : resolve(auditDir, artifact);
}

function relativeArtifact(auditDir, artifactPath) {
	const relativePath = relative(auditDir, artifactPath);
	if (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath)) {
		return relativePath;
	}
	return artifactPath;
}

async function assertFileExists(filePath, label) {
	try {
		const fileStat = await stat(filePath);
		if (!fileStat.isFile()) {
			throw new Error(`${label} is not a file: ${filePath}`);
		}
	} catch (error) {
		if (error instanceof Error && error.message.includes("is not a file")) {
			throw error;
		}
		throw new Error(`${label} not found: ${filePath}`);
	}
}

function parseArgs(argv) {
	const options = {};
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--audit-yml") options.auditYmlPath = argv[++i];
		else if (arg === "--audit-dir") options.auditDir = argv[++i];
		else if (arg === "--stage") options.stage = argv[++i];
		else if (arg === "--artifact") options.artifactPath = argv[++i];
		else if (arg === "--prompt") options.promptPath = argv[++i];
		else if (arg === "--tool") options.tool = argv[++i];
		else if (arg === "--model") options.model = argv[++i];
		else if (arg === "--session-id") options.sessionId = argv[++i];
		else if (arg === "--dispatch-id") options.dispatchId = argv[++i];
		else if (arg === "--reviewer-key") options.reviewerKey = argv[++i];
		else if (arg === "--scope") options.scope = argv[++i];
		else if (arg === "--help" || arg === "-h") options.help = true;
		else if (!options.auditDir && !options.auditYmlPath) options.auditDir = arg;
		else throw new Error(`Unknown argument: ${arg}`);
	}
	return options;
}

function usage() {
	return `Usage: node scripts/record-stage.mjs --audit-dir <dir> --stage <primary|peer|final-diff|verification> --tool <tool> --model <model> --session-id <id> [--artifact <path>] [--prompt <path>] [--dispatch-id <id>] [--reviewer-key <key>] [--scope <scope>]\n\nExamples:\n  node scripts/record-stage.mjs --audit-dir .audit/local/audits/20260507-audit --stage primary --tool pi-subagent --model openai/example --session-id primary-run\n  node scripts/record-stage.mjs --audit-dir .audit/local/audits/20260507-audit --stage final-diff --tool pi-subagent --model openai/example --session-id final-run\n  node scripts/record-stage.mjs --audit-dir .audit/local/audits/20260507-audit --stage verification --reviewer-key verifier-peer-only --prompt verification-peer-only-prompt.md --artifact verification-peer-only.md --scope "peer-only findings" --tool pi-subagent --model openai/example --session-id verifier-run\n`;
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		console.log(usage());
		return;
	}
	const result = await recordAuditStage(options);
	console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
