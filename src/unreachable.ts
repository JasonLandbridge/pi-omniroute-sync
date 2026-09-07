import { probeHealth, type HealthProbeResult } from "./provider.ts";
import type { OmniConfig, OnUnreachable } from "./config.ts";
import type { AgentEndMessage, OmniContext } from "./contracts.ts";

export type { OnUnreachable };

export interface HostModelRef {
	provider: string;
	id: string;
}

export interface UnreachableEvent {
	serverUrl: string;
}

export interface UnreachableHopOptions {
	onUnreachable: OnUnreachable;
	fallbackModel: string;
	omniProviderName: string;
	currentProvider?: string;
	currentModelId?: string;
	findModel?: (provider: string, id: string) => unknown;
	setModel?: (model: unknown) => Promise<boolean> | boolean;
	notify?: (message: string, type?: "info" | "warning" | "error") => void;
}

const SUCCESS_PROBE_CACHE_MS = 8_000;

export function parseFallbackModel(value: string): HostModelRef | undefined {
	const trimmed = value.trim();
	const slash = trimmed.indexOf("/");
	if (slash <= 0 || slash === trimmed.length - 1) return undefined;
	return { provider: trimmed.slice(0, slash), id: trimmed.slice(slash + 1) };
}

export function isUnreachableHttpStatus(status?: number): boolean {
	if (status === undefined) return true;
	return status === 0 || status === 408 || status >= 500;
}

// Response hooks do not see transport exceptions, so inspect the finalized assistant error as a fallback.
const UNREACHABLE_ERROR_PATTERN =
	/\b(?:408|5\d{2})\b|\b(?:ECONNREFUSED|ECONNRESET|ECONNABORTED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN)\b|(?:fetch failed|network error|connection (?:error|failure|refused|reset|closed)|timed?\s*out|timeout|socket)/i;

export function isUnreachableRequestFailure(message: AgentEndMessage | undefined, omniProviderName: string): boolean {
	if (message?.role !== "assistant" || message.provider !== omniProviderName || message.stopReason !== "error") return false;
	return UNREACHABLE_ERROR_PATTERN.test(message.errorMessage ?? "");
}

export function isOmniActiveModel(
	model: { provider?: string } | undefined,
	omniProviderName: string,
): boolean {
	return !model?.provider || model.provider === omniProviderName;
}

export function shouldAttemptHop(
	options: Pick<UnreachableHopOptions, "onUnreachable" | "omniProviderName" | "currentProvider" | "currentModelId" | "fallbackModel">,
): boolean {
	if (options.onUnreachable !== "host-fallback") return false;
	if (options.currentProvider && options.currentProvider !== options.omniProviderName) return false;
	const target = parseFallbackModel(options.fallbackModel);
	if (!target || target.provider === options.omniProviderName) return false;
	return !(options.currentProvider === target.provider && options.currentModelId === target.id);
}

export async function hopOnUnreachable(event: UnreachableEvent, options: UnreachableHopOptions): Promise<boolean> {
	const target = parseFallbackModel(options.fallbackModel);
	if (!shouldAttemptHop(options)) {
		const activeOmni = !options.currentProvider || options.currentProvider === options.omniProviderName;
		if (options.onUnreachable === "host-fallback" && activeOmni && (!target || target.provider === options.omniProviderName)) {
			options.notify?.(
				`OmniRoute unreachable at ${event.serverUrl}. Configure fallbackModel as an authenticated host provider/id, or use /model <provider/id> manually.`,
				"warning",
			);
		}
		return false;
	}
	if (!target) return false;

	const model = options.findModel?.(target.provider, target.id);
	if (!model || !options.setModel) {
		options.notify?.(
			`OmniRoute unreachable at ${event.serverUrl}. Host fallback ${target.provider}/${target.id} is unavailable. Use /model ${target.provider}/${target.id}.`,
			"warning",
		);
		return false;
	}

	let success: boolean;
	try {
		success = await options.setModel(model);
	} catch {
		success = false;
	}
	if (!success) {
		options.notify?.(
			`OmniRoute unreachable at ${event.serverUrl}. Host fallback ${target.provider}/${target.id} is not authenticated.`,
			"error",
		);
		return false;
	}

	options.notify?.(
		`OmniRoute unreachable at ${event.serverUrl}; hopped to ${target.provider}/${target.id}.`,
		"warning",
	);
	return true;
}

/** Coalesce compatible probes without allowing an older request to repopulate the success cache. */
export function createUnreachableController(): {
	probe(config: OmniConfig, signal?: AbortSignal, force?: boolean): Promise<HealthProbeResult>;
	reset(): void;
} {
	let lastSuccess: { url: string; at: number } | undefined;
	let inFlight: { url: string; signal?: AbortSignal; promise: Promise<HealthProbeResult> } | undefined;
	let generation = 0;
	let requestId = 0;

	return {
		async probe(config, signal, force = false) {
			if (inFlight?.url === config.serverUrl && inFlight.signal === signal) return inFlight.promise;
			if (!force && lastSuccess && lastSuccess.url === config.serverUrl && Date.now() - lastSuccess.at < SUCCESS_PROBE_CACHE_MS) {
				return { ok: true, unreachable: false };
			}

			const startedAt = generation;
			const startedRequest = ++requestId;
			const promise = probeHealth(config, signal)
				.then((result) => {
					if (result.ok && generation === startedAt && requestId === startedRequest) lastSuccess = { url: config.serverUrl, at: Date.now() };
					else if (!result.ok) lastSuccess = undefined;
					return result;
				})
				.finally(() => {
					if (inFlight?.promise === promise) inFlight = undefined;
				});
			inFlight = { url: config.serverUrl, signal, promise };
			return promise;
		},
		reset() {
			lastSuccess = undefined;
			generation += 1;
			requestId += 1;
		},
	};
}

export function hopOptionsFromContext(
	ctx: OmniContext,
	settings: Pick<UnreachableHopOptions, "onUnreachable" | "fallbackModel" | "omniProviderName">,
	setModel?: UnreachableHopOptions["setModel"],
): UnreachableHopOptions {
	return {
		...settings,
		currentProvider: ctx.model?.provider,
		currentModelId: ctx.model?.id,
		findModel: ctx.modelRegistry ? ctx.modelRegistry.find.bind(ctx.modelRegistry) : undefined,
		setModel,
		notify: ctx.hasUI ? ctx.ui.notify.bind(ctx.ui) : undefined,
	};
}
