import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentHomeOptions } from "./contracts.ts";

export const ON_UNREACHABLE_VALUES = ["none", "host-fallback"] as const;
export type OnUnreachable = (typeof ON_UNREACHABLE_VALUES)[number];

export interface OmniConfig {
	serverUrl: string;
	apiKey: string;
	providerName: string;
}

export interface OmniSettings {
	serverUrl: string;
	providerName: string;
	onlyShowUsableModels: boolean;
	showGlobalRoutingModels: boolean;
	includeModels: string[];
	excludeModels: string[];
	syncOnStartup: boolean;
	modelCacheTtlMinutes: number;
	/** Background catalog refresh while the host is running. 0 disables. Default 300 seconds. */
	autoSyncIntervalSeconds: number;
	/** Display gateway-reported tok/s after OmniRoute turns. */
	showGatewayTokensPerSecond: boolean;
	lastSuccessfulSyncAt: number;
	onUnreachable: OnUnreachable;
	fallbackModel: string;
	apiKey: string;
}

const EXTENSION_STATE_DIR = "pi-omniroute-sync";
const DEFAULT_SETTINGS: OmniSettings = {
	serverUrl: "http://localhost:20128",
	providerName: "omni",
	onlyShowUsableModels: true,
	showGlobalRoutingModels: true,
	includeModels: [],
	excludeModels: [],
	syncOnStartup: true,
	modelCacheTtlMinutes: 60,
	autoSyncIntervalSeconds: 300,
	showGatewayTokensPerSecond: false,
	lastSuccessfulSyncAt: 0,
	onUnreachable: "none",
	fallbackModel: "",
	apiKey: "",
};

export function resolveAgentHome(opts: AgentHomeOptions): string {
	const env = process.env[opts.homeEnvVar];
	if (env) return env;
	const parts = opts.defaultHome.replace(/^~\//, "").split("/");
	return join(homedir(), ...parts);
}

export function modelsJsonPath(agentHome: string): string {
	return join(agentHome, "models.json");
}

export function settingsPath(agentHome: string): string {
	return join(agentHome, "extensions", EXTENSION_STATE_DIR, "settings.json");
}

export function sanitizeSettings(input: Partial<OmniSettings>): OmniSettings {
	// Accept settings written by the short-lived millisecond version of autosync.
	const legacyIntervalMs = (input as { autoSyncIntervalMs?: unknown }).autoSyncIntervalMs;
	const intervalSeconds = input.autoSyncIntervalSeconds ?? (typeof legacyIntervalMs === "number" ? legacyIntervalMs / 1000 : undefined);
	return {
		serverUrl: normalizeServerUrl(String(input.serverUrl || DEFAULT_SETTINGS.serverUrl)),
		providerName: String(input.providerName || DEFAULT_SETTINGS.providerName).trim() || DEFAULT_SETTINGS.providerName,
		onlyShowUsableModels: input.onlyShowUsableModels !== false,
		showGlobalRoutingModels: input.showGlobalRoutingModels !== false,
		includeModels: Array.isArray(input.includeModels) ? input.includeModels.filter((value): value is string => typeof value === "string") : [],
		excludeModels: Array.isArray(input.excludeModels) ? input.excludeModels.filter((value): value is string => typeof value === "string") : [],
		syncOnStartup: input.syncOnStartup !== false,
		modelCacheTtlMinutes:
			Number.isFinite(input.modelCacheTtlMinutes) && input.modelCacheTtlMinutes! >= 0
				? input.modelCacheTtlMinutes!
				: DEFAULT_SETTINGS.modelCacheTtlMinutes,
		autoSyncIntervalSeconds:
			typeof intervalSeconds === "number" && Number.isFinite(intervalSeconds) && intervalSeconds >= 0
				? Math.floor(intervalSeconds)
				: DEFAULT_SETTINGS.autoSyncIntervalSeconds,
		showGatewayTokensPerSecond: input.showGatewayTokensPerSecond === true,
		lastSuccessfulSyncAt:
			Number.isFinite(input.lastSuccessfulSyncAt) && input.lastSuccessfulSyncAt! >= 0 ? input.lastSuccessfulSyncAt! : 0,
		onUnreachable: ON_UNREACHABLE_VALUES.includes(input.onUnreachable as OnUnreachable)
			? (input.onUnreachable as OnUnreachable)
			: DEFAULT_SETTINGS.onUnreachable,
		fallbackModel: String(input.fallbackModel ?? "").trim(),
		apiKey: String(input.apiKey ?? ""),
	};
}

export function loadSettings(agentHome: string): OmniSettings {
	try {
		return sanitizeSettings(JSON.parse(readFileSync(settingsPath(agentHome), "utf8")));
	} catch {
		return DEFAULT_SETTINGS;
	}
}

function normalizeServerUrl(value: string): string {
	let url = value.trim().replace(/\/+$/, "");
	if (url.endsWith("/v1")) url = url.slice(0, -3);
	return url || DEFAULT_SETTINGS.serverUrl;
}

/**
 * Probe the URL saved by /omni setup when a settings file exists.
 * OMNIROUTE_URL is used only when the extension has not been configured yet.
 */
export function resolveConfiguredServerUrl(agentHome: string): string {
	const settings = loadSettings(agentHome);
	if (isConfigured(agentHome)) return settings.serverUrl;
	return normalizeServerUrl(process.env.OMNIROUTE_URL ?? settings.serverUrl);
}

export function loadProbeConfig(agentHome: string): OmniConfig {
	const runtime = loadConfig(agentHome);
	return { ...runtime, serverUrl: resolveConfiguredServerUrl(agentHome) };
}

export function loadHopSettings(agentHome: string): Pick<OmniSettings, "onUnreachable" | "fallbackModel"> {
	const settings = loadSettings(agentHome);
	const onUnreachable = process.env.OMNIROUTE_ON_UNREACHABLE;
	const fallbackModel = process.env.OMNIROUTE_FALLBACK_MODEL;
	return {
		onUnreachable: ON_UNREACHABLE_VALUES.includes(onUnreachable as OnUnreachable)
			? (onUnreachable as OnUnreachable)
			: settings.onUnreachable,
		fallbackModel: (fallbackModel ?? settings.fallbackModel).trim(),
	};
}

export function sanitizeConfig(input: Partial<OmniConfig>): OmniConfig {
	const settings = sanitizeSettings(input);
	return { serverUrl: settings.serverUrl, apiKey: String(input.apiKey ?? ""), providerName: settings.providerName };
}

export function loadConfig(agentHome: string): OmniConfig {
	const settings = loadSettings(agentHome);
	return sanitizeConfig({
		...settings,
		serverUrl: process.env.OMNIROUTE_URL ?? settings.serverUrl,
		apiKey: process.env.OMNIROUTE_API_KEY ?? settings.apiKey,
		providerName: process.env.OMNIROUTE_PROVIDER_NAME ?? settings.providerName,
	});
}

export function saveSettings(agentHome: string, settings: OmniSettings): void {
	const path = settingsPath(agentHome);
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	writeFileSync(path, JSON.stringify(sanitizeSettings(settings), null, 2), { mode: 0o600 });
	chmodSync(dirname(path), 0o700);
	chmodSync(path, 0o600);
}

export function saveConfig(agentHome: string, config: OmniConfig, currentSettings = loadSettings(agentHome)): void {
	saveSettings(agentHome, sanitizeSettings({ ...currentSettings, ...config }));
}

export function isConfigured(agentHome: string): boolean {
	return existsSync(settingsPath(agentHome));
}
