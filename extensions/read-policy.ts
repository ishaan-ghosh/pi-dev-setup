/**
 * Read Policy Extension
 *
 * Enforces a read strategy that keeps context smaller:
 * - Prefer grep/find/ls to locate what matters.
 * - Then use read with pagination (`offset`/`limit`) instead of full-file reads.
 * - Allow a full-file read only when explicitly requested in the user prompt.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";

const DEFAULT_READ_LIMIT = 200;
const MAX_READ_LIMIT = 400;

const FULL_FILE_REQUEST_PATTERN = /\b(?:read|open|inspect)\s+(?:the\s+)?(?:entire|full|whole)\s+(?:contents?|file)|\ball\s+contents\b|\bfull\s+file\b/i;

let allowFullReadForPrompt = false;
let searchUsedForPrompt = false;
let warnedAboutReadPolicy = false;

function resetPromptState(userText: string) {
	allowFullReadForPrompt = FULL_FILE_REQUEST_PATTERN.test(userText);
	searchUsedForPrompt = false;
	warnedAboutReadPolicy = false;
}

function normalizeNumber(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return undefined;
	}

	if (value <= 0) {
		return undefined;
	}

	return value;
}

export default function (pi: ExtensionAPI) {
	// Start each prompt with a clean policy state.
	pi.on("input", (event) => {
		resetPromptState(event.text);
	});

	pi.on("tool_call", (event, ctx) => {
		// Search tools can "unlock" unbounded reads for this prompt.
		if (isToolCallEventType("grep", event) || isToolCallEventType("find", event) || isToolCallEventType("ls", event)) {
			searchUsedForPrompt = true;
			return;
		}

		if (!isToolCallEventType("read", event)) {
			return;
		}

		const canReadUnbounded = allowFullReadForPrompt || searchUsedForPrompt;

		if (canReadUnbounded) {
			if (typeof event.input.limit === "number" && event.input.limit > MAX_READ_LIMIT) {
				event.input.limit = MAX_READ_LIMIT;
			}
			return;
		}

		let changed = false;

		const currentOffset = normalizeNumber(event.input.offset);
		if (currentOffset === undefined) {
			event.input.offset = 1;
			changed = true;
		} else if (currentOffset !== event.input.offset) {
			event.input.offset = currentOffset;
			changed = true;
		}

		const currentLimit = normalizeNumber(event.input.limit);
		if (currentLimit === undefined) {
			event.input.limit = DEFAULT_READ_LIMIT;
			changed = true;
		} else if (currentLimit !== event.input.limit) {
			event.input.limit = currentLimit;
			changed = true;
		} else if (currentLimit > MAX_READ_LIMIT) {
			event.input.limit = MAX_READ_LIMIT;
			changed = true;
		}

		if (changed && !warnedAboutReadPolicy && ctx.hasUI) {
			ctx.ui.notify(
				"Read policy active: reads are paginated by default. Use grep/find/ls first, then read with `offset`/`limit` (or explicitly request a full file read).",
				"info",
			);
			warnedAboutReadPolicy = true;
		}
	});

	// Ensure clean state when switching sessions or reloading.
	pi.on("session_start", () => {
		allowFullReadForPrompt = false;
		searchUsedForPrompt = false;
		warnedAboutReadPolicy = false;
	});
}
