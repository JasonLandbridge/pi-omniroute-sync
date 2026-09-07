import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { modelsJsonPath, saveSettings, type OmniConfig, type OmniSettings } from "./config.ts";
import type { OmniPI, OmniRequestModel, OmniThinking, ProviderApi, ProviderCompat, ProviderEntry, ProviderModelConfig, ProviderThinkingLevel, ProviderThinkingLevelMap } from "./contracts.ts";

const DEFAULT_PROVIDER_API: ProviderApi = "openai-responses";
export const PROVIDER_COMPAT: ProviderCompat = {
	sessionAffinityFormat: "openrouter",
	promptCacheSessionHeader: "x-session-id",
	supportsLongCacheRetention: true,
};
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tiers: [] } as const;
const THINKING_LEVELS: ProviderThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];
const OMP_EFFORTS = new Set<string>(THINKING_LEVELS);
const VISUAL_MODALITIES = new Set(["image", "pdf", "video"]);
const NON_CHAT_TYPES = new Set(["image", "embedding", "rerank", "audio", "video", "pdf"]);
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

let activeInferenceApi: ProviderApi = DEFAULT_PROVIDER_API;

export function setInferenceApi(api?: ProviderApi): void {
	activeInferenceApi = api === "openai-completions" ? "openai-completions" : DEFAULT_PROVIDER_API;
}

function providerApi(): ProviderApi {
	return activeInferenceApi;
}

function modelCompat(omitMaxOutputTokens = false): ProviderCompat {
	return {
		...PROVIDER_COMPAT,
		...(providerApi() === DEFAULT_PROVIDER_API && omitMaxOutputTokens ? { supportsMaxOutputTokens: false } : {}),
	};
}

interface OmniApiModel {
	id?: string;
	name?: string;
	owned_by?: string;
	context_length?: number;
	max_input_tokens?: number;
	max_output_tokens?: number;
	max_tokens?: number;
	reasoning?: boolean;
	effort_tiers?: unknown;
	capabilities?: {
		reasoning?: boolean;
		thinking?: boolean;
		supportsThinking?: boolean;
		vision?: boolean;
		attachment?: boolean;
		pdf?: boolean;
		video?: boolean;
		tool_calling?: boolean;
		effort_tiers?: unknown;
	};
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
	omitMaxOutputTokens?: boolean;
	reasoning?: boolean;
	supportsTools?: boolean;
	thinking?: OmniThinking;
	thinkingLevelMap?: ProviderThinkingLevelMap;
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

/** Older hosts build these fields without reading newer catalog capability metadata. */
export function transformProviderPayload(payload: unknown, model: OmniRequestModel | undefined, providerName: string): unknown {
	if (!model || model.provider !== providerName || typeof payload !== "object" || payload === null || Array.isArray(payload)) return payload;

	const next = { ...(payload as Record<string, unknown>) };
	let changed = false;
	const remove = (key: string): void => {
		if (key in next) {
			delete next[key];
			changed = true;
		}
	};

	if (model.omitMaxOutputTokens) {
		remove("max_output_tokens");
		remove("max_tokens");
		remove("max_completion_tokens");
	}
	if (model.supportsTools === false) {
		remove("tools");
		remove("tool_choice");
		remove("parallel_tool_calls");
	}
	return changed ? next : payload;
}

export async function checkHealth(config: OmniConfig, signal?: AbortSignal): Promise<boolean> {
	try {
		const res = await fetch(`${config.serverUrl}/api/health/ping`, {
			headers: authHeaders(config),
			signal: requestSignal(3_000, signal),
		});
		return res.ok;
	} catch (error) {
		if (signal?.aborted) throw error;
		return false;
	}
}

export async function checkModelsEndpoint(config: OmniConfig, signal?: AbortSignal): Promise<boolean> {
	try {
		const res = await fetch(`${config.serverUrl}/v1/models`, {
			headers: authHeaders(config),
			signal: requestSignal(5_000, signal),
		});
		return res.ok;
	} catch (error) {
		if (signal?.aborted) throw error;
		return false;
	}
}

function rawModalities(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.map((item) => String(item).trim().toLowerCase()).filter(Boolean);
}

function normalizeInputModalities(model: OmniApiModel): string[] {
	const raw = rawModalities(model.input_modalities ?? model.input);
	const capabilities = model.capabilities;
	const visual =
		raw.some((item) => VISUAL_MODALITIES.has(item)) ||
		capabilities?.vision === true ||
		capabilities?.attachment === true ||
		capabilities?.pdf === true ||
		capabilities?.video === true;
	return visual ? ["text", "image"] : ["text"];
}

function isPiChatModel(model: OmniApiModel): boolean {
	const type = String(model.type || "chat").toLowerCase();
	if (NON_CHAT_TYPES.has(type)) return false;
	const output = rawModalities(model.output_modalities ?? model.output);
	if (output.length === 0) return true;
	return output.includes("text");
}

function mapThinking(model: OmniApiModel): OmniThinking | undefined {
	const raw = Array.isArray(model.effort_tiers)
		? model.effort_tiers
		: Array.isArray(model.capabilities?.effort_tiers)
			? model.capabilities.effort_tiers
			: undefined;
	if (!raw) return undefined;
	const efforts = Array.from(
		new Set(
			raw
				.filter((item): item is string => typeof item === "string")
				.map((item) => item.trim().toLowerCase())
				.filter((item) => OMP_EFFORTS.has(item)),
		),
	);
	if (efforts.length === 0) return undefined;
	return { mode: "effort", efforts };
}

function thinkingLevelMap(thinking: OmniThinking | undefined): ProviderThinkingLevelMap | undefined {
	if (!thinking) return undefined;
	const supported = new Set(thinking.efforts);
	return {
		off: "none",
		...Object.fromEntries(THINKING_LEVELS.map((level) => [level, supported.has(level) ? level : null])),
	} as ProviderThinkingLevelMap;
}

function positiveNumber(value: unknown): number | undefined {
	const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
	return Number.isFinite(n) && n > 0 ? n : undefined;
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
		omitMaxOutputTokens: next.omitMaxOutputTokens ?? existing.omitMaxOutputTokens,
		reasoning: existing.reasoning || next.reasoning,
		supportsTools: next.supportsTools ?? existing.supportsTools,
		thinking: next.thinking ?? existing.thinking,
		thinkingLevelMap: next.thinkingLevelMap ?? existing.thinkingLevelMap,
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

async function fetchUsableProviders(config: OmniConfig, signal?: AbortSignal): Promise<Set<string> | undefined> {
	try {
		const [providers, pricing] = await Promise.all([
			requestJson<{ connections?: ProviderConnection[] }>(config, "/api/providers?limit=10000", {}, 10_000, signal),
			requestJson<Record<string, PricingProvider>>(config, "/api/pricing/models", {}, 10_000, signal),
		]);
		return usableProviderAliases(providers.connections ?? [], Object.values(pricing));
	} catch (error) {
		if (signal?.aborted) throw error;
		return undefined;
	}
}

async function fetchPricing(config: OmniConfig, signal?: AbortSignal): Promise<Record<string, ModelPricing>> {
	try {
		const providers = await requestJson<Record<string, Record<string, ModelPricing>>>(config, "/api/pricing", {}, 10_000, signal);
		const result: Record<string, ModelPricing> = {};
		for (const [provider, models] of Object.entries(providers)) {
			if (!models || typeof models !== "object") continue;
			for (const [model, pricing] of Object.entries(models)) {
				result[`${provider}/${model}`] = pricing;
				result[model] ??= pricing;
			}
		}
		return result;
	} catch (error) {
		if (signal?.aborted) throw error;
		return {};
	}
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

		const contextWindow = positiveNumber(model.context_length) ?? positiveNumber(model.max_input_tokens);
		const maxTokens = positiveNumber(model.max_output_tokens) ?? positiveNumber(model.max_tokens);
		const toolCalling = model.capabilities?.tool_calling;
		const thinking = mapThinking(model);
		const synced: SyncedModel = {
			id: model.id,
			name: model.name ?? model.id,
			owned_by: model.owned_by,
			enabled: model.enabled,
			input: normalizeInputModalities(model),
			reasoning: Boolean(
				model.reasoning ||
					model.capabilities?.reasoning ||
					model.capabilities?.thinking ||
					model.capabilities?.supportsThinking,
			),
			thinking,
			thinkingLevelMap: thinkingLevelMap(thinking),
			omitMaxOutputTokens: !maxTokens,
		};
		if (contextWindow) synced.contextWindow = contextWindow;
		if (maxTokens) synced.maxTokens = maxTokens;
		if (toolCalling === true) synced.supportsTools = true;
		if (toolCalling === false) synced.supportsTools = false;
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
	const contextWindow = model.contextWindow ?? 128_000;
	const maxTokens = model.maxTokens ?? contextWindow;
	const config: ProviderModelConfig = {
		id: model.id,
		name: model.name,
		api: providerApi(),
		reasoning: model.reasoning ?? false,
		input: model.input ?? ["text"],
		cost: modelCost(pricing),
		contextWindow,
		maxTokens,
		compat: modelCompat(model.omitMaxOutputTokens),
	};
	if (model.omitMaxOutputTokens) config.omitMaxOutputTokens = true;
	if (model.supportsTools !== undefined) config.supportsTools = model.supportsTools;
	if (model.thinking) {
		config.thinking = model.thinking;
		if (providerApi() === DEFAULT_PROVIDER_API) config.thinkingLevelMap = model.thinkingLevelMap ?? thinkingLevelMap(model.thinking);
	}
	return config;
}

function buildAutoModel(id: string): ProviderModelConfig {
	return buildModel({
		id,
		name: id,
		reasoning: /coding|smart|reasoning|pro-/.test(id),
		input: ["text", "image"],
		omitMaxOutputTokens: true,
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
			.filter((model) =>
				shouldIncludeModel(
					model,
					usableProviders === undefined && settings.onlyShowUsableModels
						? { ...settings, onlyShowUsableModels: false }
						: settings,
					usableProviders,
				),
			)
			.map((model) => buildModel(model, pricing[model.id] ?? pricing[model.id.split("/").at(-1) ?? model.id])),
	];
}

function buildProviderEntry(config: OmniConfig, models: ProviderModelConfig[]): ProviderEntry {
	return {
		baseUrl: `${config.serverUrl}/v1`,
		apiKey: config.apiKey || "omniroute-public",
		api: providerApi(),
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
	const persistedModels = models.map((model) => {
		if (!model.omitMaxOutputTokens) return model;
		const { maxTokens: _maxTokens, ...withoutMaxTokens } = model;
		return withoutMaxTokens as ProviderModelConfig;
	});
	file.providers[config.providerName] = {
		baseUrl: `${config.serverUrl}/v1`,
		api: providerApi(),
		auth: "none",
		authHeader: true,
		compat: PROVIDER_COMPAT,
		models: persistedModels,
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
	return models.filter((model): model is Partial<ProviderModelConfig> & Pick<ProviderModelConfig, "id"> => Boolean(model.id)).map((model) => {
		const contextWindow = model.contextWindow ?? 128_000;
		const hasOutputLimit = typeof model.maxTokens === "number" && Number.isFinite(model.maxTokens) && model.maxTokens > 0;
		const omitMaxOutputTokens = model.omitMaxOutputTokens ?? !hasOutputLimit;
		const next: ProviderModelConfig = {
			id: model.id,
			name: model.name ?? model.id,
			api: providerApi(),
			reasoning: model.reasoning ?? false,
			input: model.input ?? ["text"],
			cost: { ...ZERO_COST, ...model.cost, tiers: model.cost?.tiers ?? [] },
			contextWindow,
			maxTokens: model.maxTokens ?? contextWindow,
			compat: { ...modelCompat(omitMaxOutputTokens), ...model.compat },
		};
		if (omitMaxOutputTokens) next.omitMaxOutputTokens = true;
		if (model.supportsTools !== undefined) next.supportsTools = model.supportsTools;
		if (model.thinking) {
			next.thinking = model.thinking;
			if (providerApi() === DEFAULT_PROVIDER_API) next.thinkingLevelMap = model.thinkingLevelMap ?? thinkingLevelMap(model.thinking);
		} else if (model.thinkingLevelMap) {
			next.thinkingLevelMap = model.thinkingLevelMap;
		}
		return next;
	});
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
		api: providerApi(),
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
	if (providerApi() === "openai-completions") {
		const data = await requestJson<{ choices?: Array<{ message?: { content?: string } }> }>(
			config,
			"/v1/chat/completions",
			{
				method: "POST",
				body: JSON.stringify({
					model,
					messages: [{ role: "user", content: "Reply with exactly: ok" }],
					stream: false,
					max_tokens: 8,
				}),
			},
			20_000,
			signal,
		);
		const content = data.choices?.[0]?.message?.content;
		return typeof content === "string" ? content.trim() : JSON.stringify(data).slice(0, 200);
	}
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
