import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { modelsJsonPath, saveSettings, type OmniConfig, type OmniSettings } from "./config.ts";
import type { OmniPI, ProviderEntry, ProviderModelConfig } from "./contracts.ts";

const PROVIDER_API = "openai-responses";
export const PROVIDER_COMPAT = {
	sessionAffinityFormat: "openrouter",
	supportsLongCacheRetention: true,
} as const;
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tiers: [] } as const;
export const AUTO_MODELS = [
	"auto",
	"auto/coding",
	"auto/fast",
	"auto/cheap",
	"auto/offline",
	"auto/smart",
	"auto/lkgp",
	"auto/best-chaos",
	"auto/best-chat",
	"auto/best-coding",
];

interface OmniApiModel {
	id?: string;
	name?: string;
	owned_by?: string;
	context_length?: number;
	max_input_tokens?: number;
	max_output_tokens?: number;
	max_tokens?: number;
	reasoning?: boolean;
	capabilities?: { reasoning?: boolean; thinking?: boolean };
	input_modalities?: unknown;
	input?: unknown;
	output_modalities?: unknown;
	output?: unknown;
	type?: string;
	enabled?: boolean;
}

interface SyncedModel {
	id: string;
	name: string;
	owned_by?: string;
	enabled?: boolean;
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
	input?: string[];
}

interface ProviderConnection {
	provider?: string;
	isActive?: boolean;
	testStatus?: string;
}

interface PricingProvider {
	id?: string;
	alias?: string;
}

export interface ModelPricing {
	input?: number;
	output?: number;
	cached?: number;
	cacheRead?: number;
	cache_creation?: number;
	cacheWrite?: number;
}

interface ModelsJson {
	providers?: Record<string, Partial<ProviderEntry>>;
}

function authHeaders(config: OmniConfig): Record<string, string> {
	return config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {};
}

function requestSignal(timeoutMs: number, signal?: AbortSignal | null): AbortSignal {
	return signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
}

async function requestJson<T>(
	config: OmniConfig,
	path: string,
	init: RequestInit = {},
	timeoutMs = 10_000,
	signal?: AbortSignal,
): Promise<T> {
	const res = await fetch(`${config.serverUrl}${path}`, {
		...init,
		headers: { "Content-Type": "application/json", ...authHeaders(config), ...(init.headers ?? {}) },
		signal: requestSignal(timeoutMs, signal ?? init.signal),
	});
	const text = await res.text();
	if (!res.ok) throw Object.assign(new Error(`${res.status}: ${text || res.statusText}`), { status: res.status });
	return (text ? JSON.parse(text) : {}) as T;
}

export async function checkHealth(config: OmniConfig, signal?: AbortSignal): Promise<boolean> {
	try {
		const res = await fetch(`${config.serverUrl}/v1/models`, {
			headers: authHeaders(config),
			signal: requestSignal(3_000, signal),
		});
		return res.ok;
	} catch (error) {
		if (signal?.aborted) throw error;
		return false;
	}
}

function normalizeModalities(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const out: string[] = [];
	for (const item of value) {
		const normalized = String(item).trim().toLowerCase();
		if ((normalized === "text" || normalized === "image") && !out.includes(normalized)) out.push(normalized);
	}
	return out;
}

function isPiChatModel(model: OmniApiModel): boolean {
	const output = normalizeModalities(model.output_modalities ?? model.output);
	if (String(model.type || "chat").toLowerCase() === "image") return false;
	return output.length === 0 || output.includes("text");
}

function upsertSyncedModel(models: SyncedModel[], next: SyncedModel): void {
	const index = models.findIndex((model) => model.id === next.id);
	if (index < 0) {
		models.push(next);
		return;
	}
	const existing = models[index];
	const input = Array.from(new Set([...(existing.input ?? []), ...(next.input ?? [])]));
	models[index] = {
		...existing,
		...next,
		input: input.length > 0 ? input : existing.input,
		contextWindow: next.contextWindow ?? existing.contextWindow,
		maxTokens: next.maxTokens ?? existing.maxTokens,
		reasoning: existing.reasoning || next.reasoning,
	};
}

export function isGlobalRoutingModel(id: string): boolean {
	return id === "auto" || id.startsWith("auto/");
}

export function globMatches(value: string, pattern: string): boolean {
	const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*").replaceAll("?", ".");
	return new RegExp(`^${escaped}$`).test(value);
}

export function shouldIncludeModel(
	model: { enabled?: boolean; id: string },
	settings: Pick<OmniSettings, "onlyShowUsableModels" | "showGlobalRoutingModels" | "includeModels" | "excludeModels">,
	usableProviders?: ReadonlySet<string>,
): boolean {
	if (!settings.showGlobalRoutingModels && isGlobalRoutingModel(model.id)) return false;
	if (settings.onlyShowUsableModels) {
		if (model.enabled === false) return false;
		if (model.id.includes("/") && !isGlobalRoutingModel(model.id) && !usableProviders?.has(model.id.split("/")[0])) return false;
	}
	if (settings.includeModels.length && !settings.includeModels.some((pattern) => globMatches(model.id, pattern))) return false;
	return !settings.excludeModels.some((pattern) => globMatches(model.id, pattern));
}

export function usableProviderAliases(connections: ProviderConnection[], pricing: PricingProvider[]): Set<string> {
	const canonicals = new Set(
		connections
			.filter((connection) => connection.isActive === true && (!connection.testStatus || connection.testStatus === "active"))
			.map((connection) => connection.provider)
			.filter((provider): provider is string => Boolean(provider)),
	);
	const aliases = new Set(canonicals);
	for (const provider of pricing) {
		if (provider.id && provider.alias && canonicals.has(provider.id)) aliases.add(provider.alias);
	}
	return aliases;
}

async function fetchUsableProviders(config: OmniConfig, signal?: AbortSignal): Promise<Set<string>> {
	const [providers, pricing] = await Promise.all([
		requestJson<{ connections?: ProviderConnection[] }>(config, "/api/providers?limit=10000", {}, 10_000, signal),
		requestJson<Record<string, PricingProvider>>(config, "/api/pricing/models", {}, 10_000, signal),
	]);
	return usableProviderAliases(providers.connections ?? [], Object.values(pricing));
}

async function fetchPricing(config: OmniConfig, signal?: AbortSignal): Promise<Record<string, ModelPricing>> {
	const providers = await requestJson<Record<string, Record<string, ModelPricing>>>(config, "/api/pricing", {}, 10_000, signal);
	const result: Record<string, ModelPricing> = {};
	for (const [provider, models] of Object.entries(providers)) {
		for (const [model, pricing] of Object.entries(models)) {
			result[`${provider}/${model}`] = pricing;
			result[model] ??= pricing;
		}
	}
	return result;
}

export function modelCost(pricing?: ModelPricing): ProviderModelConfig["cost"] {
	return {
		input: Number.isFinite(pricing?.input) ? pricing!.input! : 0,
		output: Number.isFinite(pricing?.output) ? pricing!.output! : 0,
		cacheRead: Number.isFinite(pricing?.cached) ? pricing!.cached! : Number.isFinite(pricing?.cacheRead) ? pricing!.cacheRead! : 0,
		cacheWrite: Number.isFinite(pricing?.cache_creation)
			? pricing!.cache_creation!
			: Number.isFinite(pricing?.cacheWrite)
				? pricing!.cacheWrite!
				: 0,
		tiers: [],
	};
}

async function fetchSyncedModels(config: OmniConfig, signal?: AbortSignal): Promise<SyncedModel[]> {
	const data = await requestJson<{ data?: Array<OmniApiModel | string> }>(config, "/v1/models", {}, 10_000, signal);
	const rawModels = Array.isArray(data.data) ? data.data : [];
	const results: SyncedModel[] = [];

	for (const rawModel of rawModels) {
		const model: OmniApiModel = typeof rawModel === "string" ? { id: rawModel } : rawModel;
		if (!model.id || !isPiChatModel(model)) continue;

		const synced: SyncedModel = { id: model.id, name: model.name ?? model.id, owned_by: model.owned_by, enabled: model.enabled };
		const input = normalizeModalities(model.input_modalities ?? model.input);
		synced.input = input.length > 0 ? input : ["text"];
		const contextWindow = model.context_length || model.max_input_tokens;
		if (contextWindow) synced.contextWindow = contextWindow;
		const maxTokens = model.max_output_tokens || model.max_tokens;
		if (maxTokens) synced.maxTokens = maxTokens;
		if (model.reasoning || model.capabilities?.reasoning || model.capabilities?.thinking) synced.reasoning = true;
		upsertSyncedModel(results, synced);
	}

	return results
		.sort((a, b) => {
			const ownerComparison = (a.owned_by || "zz").localeCompare(b.owned_by || "zz");
			return ownerComparison || a.id.localeCompare(b.id);
		})
		.map(({ owned_by: _ownedBy, ...model }) => model);
}

function buildModel(model: SyncedModel, pricing?: ModelPricing): ProviderModelConfig {
	return {
		id: model.id,
		name: model.name,
		api: PROVIDER_API,
		reasoning: model.reasoning ?? false,
		input: model.input ?? ["text"],
		cost: modelCost(pricing),
		contextWindow: model.contextWindow ?? 128_000,
		maxTokens: model.maxTokens ?? 16_384,
	};
}

function buildAutoModel(id: string): ProviderModelConfig {
	return buildModel({
		id,
		name: id,
		reasoning: id === "auto/coding" || id === "auto/smart",
		input: ["text", "image"],
	});
}

export async function discoverModels(config: OmniConfig, settings: OmniSettings, signal?: AbortSignal): Promise<ProviderModelConfig[]> {
	const [synced, usableProviders, pricing] = await Promise.all([
		fetchSyncedModels(config, signal),
		settings.onlyShowUsableModels ? fetchUsableProviders(config, signal) : undefined,
		fetchPricing(config, signal),
	]);
	const syncedIds = new Set(synced.map((model) => model.id));
	return [
		...(settings.showGlobalRoutingModels ? AUTO_MODELS.filter((id) => !syncedIds.has(id)).map(buildAutoModel) : []),
		...synced
			.filter((model) => shouldIncludeModel(model, settings, usableProviders))
			.map((model) => buildModel(model, pricing[model.id] ?? pricing[model.id.split("/").at(-1) ?? model.id])),
	];
}

function buildProviderEntry(config: OmniConfig, models: ProviderModelConfig[]): ProviderEntry {
	return {
		baseUrl: `${config.serverUrl}/v1`,
		apiKey: config.apiKey || "omniroute-public",
		api: PROVIDER_API,
		authHeader: true,
		compat: PROVIDER_COMPAT,
		models,
	};
}

function readModelsJson(agentHome: string): ModelsJson {
	try {
		return JSON.parse(readFileSync(modelsJsonPath(agentHome), "utf8")) as ModelsJson;
	} catch {
		return {};
	}
}

function persistModels(agentHome: string, config: OmniConfig, models: ProviderModelConfig[]): void {
	const path = modelsJsonPath(agentHome);
	const file = readModelsJson(agentHome);
	file.providers ??= {};
	file.providers[config.providerName] = {
		baseUrl: `${config.serverUrl}/v1`,
		api: PROVIDER_API,
		authHeader: true,
		compat: PROVIDER_COMPAT,
		models,
	};
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(file, null, 2));
}

export async function registerOmniProvider(
	pi: OmniPI,
	agentHome: string,
	config: OmniConfig,
	settings: OmniSettings,
	signal?: AbortSignal,
): Promise<ProviderModelConfig[]> {
	const models = await discoverModels(config, settings, signal);
	pi.registerProvider(config.providerName, buildProviderEntry(config, models));
	persistModels(agentHome, config, models);
	saveSettings(agentHome, { ...settings, lastSuccessfulSyncAt: Date.now() });
	return models;
}

export function normalizePersistedModels(models: Array<Partial<ProviderModelConfig>>): ProviderModelConfig[] {
	return models.filter((model): model is Partial<ProviderModelConfig> & Pick<ProviderModelConfig, "id"> => Boolean(model.id)).map((model) => ({
		id: model.id,
		name: model.name ?? model.id,
		api: PROVIDER_API,
		reasoning: model.reasoning ?? false,
		input: model.input ?? ["text"],
		cost: { ...ZERO_COST, ...model.cost, tiers: model.cost?.tiers ?? [] },
		contextWindow: model.contextWindow ?? 128_000,
		maxTokens: model.maxTokens ?? 16_384,
	}));
}

export function isSyncStale(
	settings: Pick<OmniSettings, "lastSuccessfulSyncAt" | "modelCacheTtlMinutes">,
	now = Date.now(),
): boolean {
	return settings.lastSuccessfulSyncAt === 0 || now - settings.lastSuccessfulSyncAt >= settings.modelCacheTtlMinutes * 60_000;
}

export function reloadOmniProvider(pi: OmniPI, agentHome: string, config: OmniConfig): void {
	const persisted = readModelsJson(agentHome).providers?.[config.providerName];
	if (!persisted?.baseUrl || !persisted.models) return;
	const models = normalizePersistedModels(persisted.models);
	pi.registerProvider(config.providerName, {
		baseUrl: persisted.baseUrl,
		apiKey: config.apiKey || "omniroute-public",
		api: PROVIDER_API,
		authHeader: true,
		compat: PROVIDER_COMPAT,
		models,
	});
}

interface ResponsesResult {
	output_text?: string;
	output?: Array<{ content?: Array<{ text?: string }> }>;
}

export async function testChat(config: OmniConfig, model: string, signal?: AbortSignal): Promise<string> {
	const data = await requestJson<ResponsesResult>(
		config,
		"/v1/responses",
		{
			method: "POST",
			body: JSON.stringify({
				model,
				input: "Reply with exactly: ok",
				stream: false,
				max_output_tokens: 8,
			}),
		},
		20_000,
		signal,
	);
	const content = data.output_text ?? data.output?.flatMap((item) => item.content ?? []).find((item) => item.text)?.text;
	return typeof content === "string" ? content.trim() : JSON.stringify(data).slice(0, 200);
}
