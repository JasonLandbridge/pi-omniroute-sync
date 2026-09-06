import { checkHealth } from "./provider.ts";
import type { OmniConfig, OnUnreachable } from "./config.ts";
import type { OmniContext } from "./contracts.ts";

export type { OnUnreachable };

export interface HostModelRef {
	provider: string;
	id: string;
}

export interface UnreachableEvent {
	serverUrl: string;
	reason: "probe" | "request-failure";
	status?: number;
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
	if (!target) return false;
	return !(options.currentProvider === target.provider && options.currentModelId === target.id);
}

export async function hopOnUnreachable(event: UnreachableEvent, options: UnreachableHopOptions): Promise<boolean> {
	if (!shouldAttemptHop(options)) return false;
	const target = parseFallbackModel(options.fallbackModel);
	if (!target) return false;

	const model = options.findModel?.(target.provider, target.id);
	if (!model || !options.setModel) {
		options.notify?.(
			`OmniRoute unreachable at ${event.serverUrl}. Host fallback ${target.provider}/${target.id} is unavailable. Use /model ${target.provider}/${target.id}.`,
			"warning",
		);
		return false;
	}

	const success = await options.setModel(model);
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

export function createUnreachableController(): {
	probe(config: OmniConfig, signal?: AbortSignal): Promise<boolean>;
	reset(): void;
} {
	let lastSuccess: { url: string; at: number } | undefined;
	let inFlight: Promise<boolean> | undefined;

	return {
		async probe(config, signal) {
			if (lastSuccess && lastSuccess.url === config.serverUrl && Date.now() - lastSuccess.at < SUCCESS_PROBE_CACHE_MS) {
				return true;
			}
			if (inFlight) return inFlight;
			inFlight = checkHealth(config, signal)
				.then((ok) => {
					if (ok) lastSuccess = { url: config.serverUrl, at: Date.now() };
					else lastSuccess = undefined;
					return ok;
				})
				.finally(() => {
					inFlight = undefined;
				});
			return inFlight;
		},
		reset() {
			lastSuccess = undefined;
			inFlight = undefined;
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
		findModel: ctx.modelRegistry?.find,
		setModel,
		notify: ctx.hasUI ? ctx.ui.notify.bind(ctx.ui) : undefined,
	};
}
