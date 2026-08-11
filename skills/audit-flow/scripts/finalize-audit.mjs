#!/usr/bin/env node

import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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

const FINAL_STATUSES = new Set(["passed", "passed_with_deferred", "blocked"]);
const REQUIRED_REVIEWERS = {
	primary: "primary-reviewer",
	peer: "peer-reviewer",
	final_diff: "final-diff-reviewer",
};
const REQUIRED_PROMPT_ARTIFACT_KEYS = {
	primary: "primary_prompt",
	peer: "peer_review_prompt",
	final_diff: "final_diff_prompt",
};
const REQUIRED_REPORT_ARTIFACT_KEYS = {
	primary: "primary_initial",
	peer: "peer_review",
	final_diff: "final_diff_review",
};
const FINDING_STATUSES = new Set([
	"candidate",
	"unverified",
	"accepted",
	"rejected",
	"deferred",
	"needs_more_info",
	"fixed",
	"partially_fixed",
	"still_open",
	"verified",
	"commented",
]);
const UNRESOLVED_FINDING_STATUSES = new Set([
	"candidate",
	"unverified",
	"accepted",
	"needs_more_info",
	"partially_fixed",
	"still_open",
]);

export async function finalizeAudit(options) {
	const auditYmlPath = resolveAuditYmlPath(options);
	const requestedStatus = String(options.status ?? "");
	if (!FINAL_STATUSES.has(requestedStatus)) {
		throw new Error(`Final status must be one of: ${[...FINAL_STATUSES].join(", ")}`);
	}
	await assertNoSymlinkComponents(auditYmlPath, "Audit metadata path");

	return withAuditMetadataLock(auditYmlPath, async () => {
		const audit = parseYamlSubset(await readFile(auditYmlPath, "utf8"));
		const auditDir = dirname(auditYmlPath);
		if (resolve(auditYmlPath) !== join(auditDir, "audit.yml")) {
			throw new Error(`Audit metadata file must be named audit.yml: ${auditYmlPath}`);
		}
		const declaredRoot = resolveDeclaredRoot(auditDir, audit.artifacts?.root);
		if (declaredRoot !== auditDir) {
			throw new Error(`Audit metadata path does not match its declared artifact root: ${auditYmlPath}`);
		}
		if ((audit.status ?? "in_progress") !== "in_progress" || audit.finalization) {
			throw new Error(`Audit is already finalized with status ${audit.status}.`);
		}

		await assertNoSymlinkComponents(auditDir, "Audit directory");
		await revalidateTargetSnapshot(audit.target);
		assertUniqueDispatchIds(audit.reviewers);

		for (const [reviewerKey, role] of Object.entries(REQUIRED_REVIEWERS)) {
			const reviewer = Object.hasOwn(audit.reviewers ?? {}, reviewerKey) ? audit.reviewers[reviewerKey] : undefined;
			await validateReviewer(auditDir, audit, reviewerKey, role, reviewer);
		}
		for (const [reviewerKey, reviewer] of Object.entries(audit.reviewers ?? {})) {
			if (Object.hasOwn(REQUIRED_REVIEWERS, reviewerKey)) continue;
			await validateSupplementalReviewer(auditDir, audit, reviewerKey, reviewer);
		}
		assertUniqueSessionIds(audit.reviewers);
		assertDistinctRequiredReportHashes(audit.reviewers);
		assertRequiredStageCompletionOrder(audit.reviewers);
		assertSupplementalCompletionOrder(audit.reviewers);

		const findingsPath = await resolveRequiredArtifact(auditDir, audit.artifacts?.findings, "findings");
		const receiptPath = await resolveRequiredArtifact(auditDir, audit.artifacts?.receipt, "receipt");
		const findingsBuffer = await readFile(findingsPath);
		const receiptBuffer = await readFile(receiptPath);
		if (receiptBuffer.length === 0) {
			throw new Error("Audit receipt must not be empty.");
		}
		const findings = parseFindings(findingsBuffer, findingsPath);
		validateFindingGate(findings, requestedStatus, audit.reviewers);

		const finalizedAt = (options.now ?? new Date()).toISOString();
		audit.status = requestedStatus;
		audit.updated_at = finalizedAt;
		audit.finalized_at = finalizedAt;
		audit.finalization = {
			status: requestedStatus,
			target_snapshot_sha256: audit.target.snapshot_sha256,
			findings_sha256: sha256(findingsBuffer),
			receipt_sha256: sha256(receiptBuffer),
			required_stages: Object.keys(REQUIRED_REVIEWERS),
			completed_at: finalizedAt,
		};
		await atomicWriteFile(auditYmlPath, toYaml(audit));

		return {
			auditYmlPath,
			auditDir,
			status: requestedStatus,
			finalizedAt,
		};
	}, { timeoutMs: options.lockTimeoutMs });
}

async function validateSupplementalReviewer(auditDir, audit, reviewerKey, reviewer) {
	if (reviewer?.role !== "finding-verifier" || !reviewer.completed_at || !reviewer.dispatch_id) {
		throw new Error(`Supplemental reviewer ${reviewerKey} is not a completed finding-verifier dispatch.`);
	}
	validateReviewerIdentity(reviewerKey, reviewer);
	assertPromptMetadataBinding(audit, reviewerKey, reviewer, `${reviewerKey.replaceAll("-", "_")}_prompt`);
	assertReportMetadataBinding(audit, reviewerKey, reviewer, reviewerKey.replaceAll("-", "_"));
	const reportPath = await resolveRequiredArtifact(auditDir, reviewer.artifact, `${reviewerKey} report`);
	const reportBuffer = await readFile(reportPath);
	if (reportBuffer.length === 0 || !reviewer.report_sha256 || sha256(reportBuffer) !== reviewer.report_sha256) {
		throw new Error(`${reviewerKey} report digest does not match the recorded report.`);
	}
	const promptPath = await resolveRequiredArtifact(auditDir, reviewer.prompt, `${reviewerKey} prompt`);
	const promptBuffer = await readFile(promptPath);
	if (promptBuffer.length === 0 || !reviewer.prompt_sha256 || sha256(promptBuffer) !== reviewer.prompt_sha256) {
		throw new Error(`${reviewerKey} prompt digest does not match the dispatched nonempty prompt.`);
	}
	validateAttestation(audit, reviewerKey, reviewer);
}

async function validateReviewer(auditDir, audit, reviewerKey, expectedRole, reviewer) {
	if (!reviewer || reviewer.role !== expectedRole) {
		throw new Error(`Finalization requires the distinct ${expectedRole} stage.`);
	}
	if (!reviewer.completed_at || !reviewer.dispatch_id) {
		throw new Error(`Finalization requires a completed ${expectedRole} stage with a dispatch ID.`);
	}
	validateReviewerIdentity(reviewerKey, reviewer);
	assertPromptMetadataBinding(audit, reviewerKey, reviewer, REQUIRED_PROMPT_ARTIFACT_KEYS[reviewerKey]);
	assertReportMetadataBinding(audit, reviewerKey, reviewer, REQUIRED_REPORT_ARTIFACT_KEYS[reviewerKey]);
	const promptPath = await resolveRequiredArtifact(auditDir, reviewer.prompt, `${expectedRole} prompt`);
	const reportPath = await resolveRequiredArtifact(auditDir, reviewer.artifact, `${expectedRole} report`);
	const promptBuffer = await readFile(promptPath);
	const reportBuffer = await readFile(reportPath);
	if (reportBuffer.length === 0) {
		throw new Error(`${expectedRole} report must not be empty.`);
	}
	if (!reviewer.prompt_sha256 || sha256(promptBuffer) !== reviewer.prompt_sha256) {
		throw new Error(`${expectedRole} prompt digest does not match the dispatched prompt.`);
	}
	if (!reviewer.report_sha256 || sha256(reportBuffer) !== reviewer.report_sha256) {
		throw new Error(`${expectedRole} report digest does not match the recorded report.`);
	}
	validateAttestation(audit, reviewerKey, reviewer);
}

function assertPromptMetadataBinding(audit, reviewerKey, reviewer, artifactKey) {
	const dispatchedPrompt = audit.artifacts?.[artifactKey];
	if (typeof dispatchedPrompt !== "string" || dispatchedPrompt === "" || reviewer.prompt !== dispatchedPrompt) {
		throw new Error(`Reviewer ${reviewerKey} prompt must match dispatched audit.artifacts.${artifactKey} metadata.`);
	}
}

function assertReportMetadataBinding(audit, reviewerKey, reviewer, artifactKey) {
	const dispatchedReport = audit.artifacts?.[artifactKey];
	if (typeof dispatchedReport !== "string" || dispatchedReport === "" || reviewer.artifact !== dispatchedReport) {
		throw new Error(`Reviewer ${reviewerKey} report must match dispatched audit.artifacts.${artifactKey} metadata.`);
	}
}

function validateReviewerIdentity(reviewerKey, reviewer) {
	for (const [field, label] of [["tool", "tool"], ["model", "model"], ["session_id", "session ID"]]) {
		if (typeof reviewer?.[field] !== "string" || reviewer[field].trim() === "") {
			throw new Error(`Reviewer ${reviewerKey} is missing nonempty ${label} identity metadata.`);
		}
	}
}

function validateAttestation(audit, reviewerKey, reviewer) {
	const attestation = reviewer.attestation;
	const expected = {
		kind: "orchestrator-attested",
		audit_id: String(audit.id),
		reviewer_key: reviewerKey,
		dispatch_id: String(reviewer.dispatch_id),
		target_snapshot_sha256: String(audit.target.snapshot_sha256),
		prompt_sha256: reviewer.prompt_sha256 ?? null,
		artifact: String(reviewer.artifact),
		report_sha256: String(reviewer.report_sha256),
		recorded_at: String(reviewer.completed_at),
	};
	if (!attestation || typeof attestation !== "object") {
		throw new Error(`Reviewer ${reviewerKey} is missing structural orchestrator attestation.`);
	}
	for (const [field, value] of Object.entries(expected)) {
		if (attestation[field] !== value) {
			throw new Error(`Reviewer ${reviewerKey} attestation does not bind ${field} to the recorded stage.`);
		}
	}
}

function assertDistinctRequiredReportHashes(reviewers) {
	const hashes = Object.keys(REQUIRED_REVIEWERS).map((key) => String(reviewers[key].report_sha256));
	if (new Set(hashes).size !== hashes.length) {
		throw new Error("Primary, peer, and final-diff report bytes must be distinct; copied fixed-stage reports are not accepted.");
	}
}

function assertRequiredStageCompletionOrder(reviewers) {
	const orderedKeys = Object.keys(REQUIRED_REVIEWERS);
	const completionTimes = orderedKeys.map((key) => {
		const value = reviewers[key].completed_at;
		const time = typeof value === "string" ? Date.parse(value) : Number.NaN;
		if (!Number.isFinite(time)) {
			throw new Error(`Reviewer ${key} has an invalid completion timestamp.`);
		}
		return time;
	});
	for (let index = 1; index < completionTimes.length; index += 1) {
		if (completionTimes[index] < completionTimes[index - 1]) {
			throw new Error("Required reviewer completion timestamps must be ordered primary, peer, then final_diff.");
		}
	}
}

function assertSupplementalCompletionOrder(reviewers) {
	const peerTime = Date.parse(reviewers.peer.completed_at);
	for (const [reviewerKey, reviewer] of Object.entries(reviewers ?? {})) {
		if (Object.hasOwn(REQUIRED_REVIEWERS, reviewerKey)) continue;
		const completionTime = typeof reviewer?.completed_at === "string"
			? Date.parse(reviewer.completed_at)
			: Number.NaN;
		if (!Number.isFinite(completionTime)) {
			throw new Error(`Supplemental reviewer ${reviewerKey} has an invalid completion timestamp.`);
		}
		if (completionTime < peerTime) {
			throw new Error(`Supplemental reviewer ${reviewerKey} must not complete before primary and peer.`);
		}
	}
}

async function resolveRequiredArtifact(auditDir, metadataPath, label) {
	if (!metadataPath) {
		throw new Error(`Audit metadata is missing the ${label} artifact path.`);
	}
	const artifactPath = isAbsolute(metadataPath) ? resolve(metadataPath) : resolve(auditDir, metadataPath);
	assertInside(auditDir, artifactPath, label);
	await assertNoSymlinkComponents(artifactPath, `${label} path`);
	try {
		const artifactStat = await stat(artifactPath);
		if (!artifactStat.isFile()) throw new Error(`${label} is not a file: ${artifactPath}`);
	} catch (error) {
		if (error instanceof Error && error.message.includes("is not a file")) throw error;
		throw new Error(`${label} artifact not found: ${artifactPath}`);
	}
	return artifactPath;
}

function parseFindings(buffer, findingsPath) {
	let document;
	try {
		document = JSON.parse(buffer.toString("utf8"));
	} catch {
		throw new Error(`Findings artifact is not valid JSON: ${findingsPath}`);
	}
	const findings = Array.isArray(document) ? document : document?.findings;
	if (!Array.isArray(findings)) {
		throw new Error("Findings JSON must be an array or an object with a findings array.");
	}
	return findings;
}

function validateFindingGate(findings, requestedStatus, reviewers) {
	let deferredCount = 0;
	for (const [index, finding] of findings.entries()) {
		if (!finding || typeof finding !== "object") {
			throw new Error(`findings[${index}] must be an object.`);
		}
		const findingLabel = finding.id ?? index;
		if (typeof finding.status !== "string" || !FINDING_STATUSES.has(finding.status)) {
			throw new Error(`Finding ${findingLabel} has missing or unknown status ${JSON.stringify(finding.status)}.`);
		}
		const sources = Array.isArray(finding.source)
			? [...new Set(finding.source.map((source) => typeof source === "string" ? source.trim() : ""))].filter(Boolean)
			: [];
		const required = finding.verification?.required;
		const artifactValues = finding.verification?.artifacts;
		const artifacts = Array.isArray(artifactValues) && artifactValues.every(
			(artifact) => typeof artifact === "string" && artifact.trim() !== "",
		)
			? new Set(artifactValues)
			: null;
		if (!Number.isInteger(required) || required < 2 || sources.length < required) {
			throw new Error(`Finding ${findingLabel} has not passed its two-reviewer finding verification gate.`);
		}
		if (!artifacts) {
			throw new Error(`Finding ${findingLabel} verification.artifacts must be an array of concrete nonempty artifact-path strings.`);
		}
		const citedHashes = [];
		for (const source of sources) {
			const reviewer = Object.hasOwn(reviewers ?? {}, source) ? reviewers[source] : undefined;
			if (!reviewer?.completed_at || !reviewer.report_sha256) {
				throw new Error(`Finding ${findingLabel} cites reviewer key without a completed recorded report: ${source}`);
			}
			validateReviewerIdentity(source, reviewer);
			if (!artifacts.has(String(reviewer.artifact))) {
				throw new Error(`Finding ${findingLabel} does not bind reviewer ${source} to its exact report artifact ${reviewer.artifact}.`);
			}
			citedHashes.push(String(reviewer.report_sha256));
		}
		if (new Set(citedHashes).size !== citedHashes.length) {
			throw new Error(`Finding ${findingLabel} cites copied reviewer reports with identical digests.`);
		}
		if (requestedStatus !== "blocked" && UNRESOLVED_FINDING_STATUSES.has(finding.status)) {
			throw new Error(`Finding ${findingLabel} is unresolved (${finding.status}); final status must be blocked.`);
		}
		if (requestedStatus === "passed" && finding.status === "deferred") {
			throw new Error(`Finding ${findingLabel} is deferred; use passed_with_deferred or blocked.`);
		}
		if (finding.status === "deferred") deferredCount += 1;
	}
	if (requestedStatus === "passed_with_deferred" && deferredCount === 0) {
		throw new Error("Final status passed_with_deferred requires at least one deferred finding.");
	}
}

function assertUniqueSessionIds(reviewers = {}) {
	const values = Object.values(reviewers)
		.filter((reviewer) => reviewer?.completed_at)
		.map((reviewer) => reviewer.session_id)
		.map(String);
	if (new Set(values).size !== values.length) {
		throw new Error("Completed reviewer session IDs must be distinct within an audit.");
	}
}

function assertInside(auditDir, candidatePath, label) {
	const relativePath = relative(auditDir, candidatePath);
	if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
		throw new Error(`${label} must be inside the selected audit directory: ${candidatePath}`);
	}
}

function resolveDeclaredRoot(auditDir, declaredRoot) {
	if (!declaredRoot) return auditDir;
	if (isAbsolute(declaredRoot)) return resolve(declaredRoot);
	if (String(declaredRoot).split(/[\\/]/).includes("..")) {
		throw new Error(`Audit metadata declares an unsafe relative artifact root: ${declaredRoot}`);
	}
	return String(declaredRoot) === "." || auditDir.endsWith(`${sep}${declaredRoot}`)
		? auditDir
		: resolve(declaredRoot);
}

function resolveAuditYmlPath(options) {
	if (options.auditYmlPath) return resolve(options.auditYmlPath);
	if (options.auditDir) return resolve(options.auditDir, "audit.yml");
	throw new Error("Missing audit metadata path. Pass --audit-yml <path> or --audit-dir <path>.");
}

function parseArgs(argv) {
	const options = {};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--audit-yml") options.auditYmlPath = argv[++index];
		else if (arg === "--audit-dir") options.auditDir = argv[++index];
		else if (arg === "--status") options.status = argv[++index];
		else if (arg === "--help" || arg === "-h") options.help = true;
		else if (!options.auditDir && !options.auditYmlPath) options.auditDir = arg;
		else throw new Error(`Unknown argument: ${arg}`);
	}
	return options;
}

function usage() {
	return "Usage: node scripts/finalize-audit.mjs --audit-yml <path> --status <passed|passed_with_deferred|blocked>\n";
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		console.log(usage());
		return;
	}
	console.log(JSON.stringify(await finalizeAudit(options), null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
