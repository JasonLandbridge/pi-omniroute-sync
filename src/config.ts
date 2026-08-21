import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentHomeOptions } from "./contracts.ts";

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
	lastSuccessfulSyncAt: number;
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
	lastSuccessfulSyncAt: 0,
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
		lastSuccessfulSyncAt:
			Number.isFinite(input.lastSuccessfulSyncAt) && input.lastSuccessfulSyncAt! >= 0 ? input.lastSuccessfulSyncAt! : 0,
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
