import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { checkHealth, globMatches, isGlobalRoutingModel, isSyncStale, modelCost, normalizePersistedModels, PROVIDER_COMPAT, registerOmniProvider, shouldIncludeModel, usableProviderAliases } from "../src/provider.ts";

const fetchStub = vi.spyOn(globalThis, "fetch");

afterEach(() => fetchStub.mockReset());

it("uses OmniRoute's supported session-affinity header", () => {
	expect(PROVIDER_COMPAT.sessionAffinityFormat).toBe("openrouter");
});

it("checks OmniRoute's lightweight health endpoint", async () => {
	fetchStub.mockResolvedValue(new Response(null, { status: 200 }));

	expect(await checkHealth({ serverUrl: "http://localhost:20128", apiKey: "secret", providerName: "omni" })).toBe(true);
	expect(fetchStub).toHaveBeenCalledWith(
		"http://localhost:20128/api/health/ping",
		expect.objectContaining({ headers: { Authorization: "Bearer secret" } }),
	);
});

it("normalizes legacy persisted models for Responses and cost tiers", () => {
	const [model] = normalizePersistedModels([{ id: "codex/gpt-5", name: "GPT-5" }, {}, { id: "" }]);

	expect(model.api).toBe("openai-responses");
	expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tiers: [] });
	expect(normalizePersistedModels([{}, { id: "" }])).toEqual([]);
});

it("persists a keyless OMP marker without leaking the API key", async () => {
	fetchStub.mockImplementation(async (input) => {
		const url = String(input);
		const body = url.endsWith("/v1/models")
			? { data: [{ id: "openai/gpt-5", name: "GPT-5" }] }
			: { openai: { "gpt-5": { input: 1, output: 2 } } };
		return new Response(JSON.stringify(body), { status: 200 });
	});

	const agentHome = mkdtempSync(join(tmpdir(), "pi-omni-provider-"));
	const registerProvider = vi.fn();
	await registerOmniProvider(
		{ registerProvider } as never,
		agentHome,
		{ serverUrl: "http://localhost:20128", apiKey: "secret", providerName: "omni" },
		{ onlyShowUsableModels: false, showGlobalRoutingModels: false, includeModels: [], excludeModels: [], syncOnStartup: true, modelCacheTtlMinutes: 60, autoSyncIntervalMs: 300000, lastSuccessfulSyncAt: 0, serverUrl: "http://localhost:20128", providerName: "omni", apiKey: "secret" },
	);

	const persisted = JSON.parse(readFileSync(join(agentHome, "models.json"), "utf8"));
	expect(persisted.providers.omni.auth).toBe("none");
	expect(persisted.providers.omni.apiKey).toBeUndefined();
	expect(registerProvider).toHaveBeenCalledWith("omni", expect.objectContaining({ apiKey: "secret" }));
});

it("filters disabled and unusable provider models when enabled-only is active", () => {
	const settings = { onlyShowUsableModels: true, showGlobalRoutingModels: true, includeModels: [], excludeModels: [] };
	const usable = new Set(["openai"]);

	expect(shouldIncludeModel({ id: "openai/gpt-5", enabled: true }, settings, usable)).toBe(true);
	expect(shouldIncludeModel({ id: "claude/sonnet" }, settings, usable)).toBe(false);
	expect(shouldIncludeModel({ id: "openai/gpt-5", enabled: false }, settings, usable)).toBe(false);
	expect(
		shouldIncludeModel(
			{ id: "claude/sonnet", enabled: false },
			{ onlyShowUsableModels: false, showGlobalRoutingModels: true, includeModels: [], excludeModels: [] },
			usable,
		),
	).toBe(true);
});

it("strict usable filtering rejects models when verification is unavailable", () => {
	const settings = { onlyShowUsableModels: true, showGlobalRoutingModels: true, includeModels: [], excludeModels: [] };
	expect(shouldIncludeModel({ id: "claude/sonnet" }, settings)).toBe(false);
});

it("recognizes every global routing model by namespace", () => {
	expect(isGlobalRoutingModel("auto")).toBe(true);
	expect(isGlobalRoutingModel("auto/lkgp")).toBe(true);
	expect(isGlobalRoutingModel("auto/future-route")).toBe(true);
	expect(isGlobalRoutingModel("openai/auto")).toBe(false);
});

it("hides advertised auto models independently of catalog filtering", () => {
	const hidden = { onlyShowUsableModels: false, showGlobalRoutingModels: false, includeModels: [], excludeModels: [] };
	const shown = { onlyShowUsableModels: false, showGlobalRoutingModels: true, includeModels: [], excludeModels: [] };

	expect(shouldIncludeModel({ id: "auto" }, hidden)).toBe(false);
	expect(shouldIncludeModel({ id: "auto/lkgp" }, hidden)).toBe(false);
	expect(shouldIncludeModel({ id: "openai/gpt-5" }, hidden)).toBe(true);
	expect(shouldIncludeModel({ id: "auto" }, shown)).toBe(true);
	expect(shouldIncludeModel({ id: "auto/lkgp" }, shown)).toBe(true);
});

it("applies include then exclude glob filters", () => {
	const settings = {
		onlyShowUsableModels: false,
		showGlobalRoutingModels: true,
		includeModels: ["openai/*", "google/gemini-?"],
		excludeModels: ["*/deprecated-*"],
	};

	expect(globMatches("openai/gpt-5", "openai/*")).toBe(true);
	expect(globMatches("google/gemini-2", "google/gemini-?")).toBe(true);
	expect(globMatches("openai/gpt.5+mini", "openai/gpt.5+*")).toBe(true);
	expect(globMatches("prefix/openai/gpt-5", "openai/*")).toBe(false);
	expect(shouldIncludeModel({ id: "openai/gpt-5" }, settings)).toBe(true);
	expect(shouldIncludeModel({ id: "claude/sonnet" }, settings)).toBe(false);
	expect(shouldIncludeModel({ id: "openai/deprecated-old" }, settings)).toBe(false);
});

it("maps OmniRoute pricing directly to Pi per-million costs", () => {
	expect(modelCost({ input: 3, output: 15, cached: 0.3, cache_creation: 3.75 })).toEqual({
		input: 3,
		output: 15,
		cacheRead: 0.3,
		cacheWrite: 3.75,
		tiers: [],
	});
	expect(modelCost({ cacheRead: 1, cacheWrite: 2 })).toMatchObject({ cacheRead: 1, cacheWrite: 2 });
	expect(modelCost({ input: Number.NaN, output: Number.POSITIVE_INFINITY })).toMatchObject({ input: 0, output: 0 });
});

it("detects stale and fresh startup sync timestamps from settings", () => {
	expect(isSyncStale({ lastSuccessfulSyncAt: 0, modelCacheTtlMinutes: 60 }, 1_000_000)).toBe(true);
	expect(isSyncStale({ lastSuccessfulSyncAt: 900_000, modelCacheTtlMinutes: 60 }, 1_000_000)).toBe(false);
	expect(isSyncStale({ lastSuccessfulSyncAt: 1_000_000, modelCacheTtlMinutes: 0 }, 1_000_000)).toBe(true);
	expect(isSyncStale({ lastSuccessfulSyncAt: 1_000_000, modelCacheTtlMinutes: 1 }, 1_060_000)).toBe(true);
});

it("maps active canonical providers to pricing aliases", () => {
	const aliases = usableProviderAliases(
		[
			{ provider: "anthropic", isActive: true, testStatus: "active" },
			{ provider: "openai", isActive: false, testStatus: "active" },
			{ provider: "google", isActive: true, testStatus: "failed" },
		],
		[
			{ id: "anthropic", alias: "claude" },
			{ id: "openai", alias: "codex" },
		],
	);

	expect([...aliases].sort()).toEqual(["anthropic", "claude"]);
	expect([...usableProviderAliases([{ provider: "openai", isActive: true }], [])]).toEqual(["openai"]);
});


it("maps vision capabilities, limits, and pricing from the catalog", async () => {
	fetchStub.mockImplementation(async (input) => {
		const url = String(input);
		if (url.endsWith("/v1/models")) {
			return new Response(JSON.stringify({
				data: [
					{ id: "openai/gpt-vision", name: "Vision", capabilities: { vision: true, tool_calling: true }, effort_tiers: ["low", "high"], context_length: 200000, max_output_tokens: 64000 },
					{ id: "google/audio-only", name: "Audio", type: "audio" },
				],
			}), { status: 200 });
		}
		if (url.includes("/api/pricing")) {
			return new Response(JSON.stringify({ openai: { "gpt-vision": { input: 5, output: 15 } } }), { status: 200 });
		}
		return new Response("{}", { status: 200 });
	});
	const { discoverModels } = await import("../src/provider.ts");
	const models = await discoverModels(
		{ serverUrl: "http://localhost:20128", apiKey: "secret", providerName: "omni" },
		{ onlyShowUsableModels: false, showGlobalRoutingModels: false, includeModels: [], excludeModels: [], syncOnStartup: true, modelCacheTtlMinutes: 60, autoSyncIntervalMs: 300000, lastSuccessfulSyncAt: 0, serverUrl: "http://localhost:20128", providerName: "omni", apiKey: "secret" },
	);
	const vision = models.find((model) => model.id === "openai/gpt-vision");
	expect(vision?.input).toEqual(["text", "image"]);
	expect(vision?.supportsTools).toBe(true);
	expect(vision?.thinking?.efforts).toEqual(["low", "high"]);
	expect(vision?.contextWindow).toBe(200000);
	expect(vision?.maxTokens).toBe(64000);
	expect(vision?.cost.input).toBe(5);
	expect(models.some((model) => model.id === "google/audio-only")).toBe(false);
});

it("keeps advertised models when usable-provider verification fails", async () => {
	fetchStub.mockImplementation(async (input) => {
		const url = String(input);
		if (url.endsWith("/v1/models")) {
			return new Response(JSON.stringify({ data: [{ id: "openai/gpt-5", name: "GPT-5" }] }), { status: 200 });
		}
		return new Response("nope", { status: 403 });
	});
	const { discoverModels } = await import("../src/provider.ts");
	const models = await discoverModels(
		{ serverUrl: "http://localhost:20128", apiKey: "secret", providerName: "omni" },
		{ onlyShowUsableModels: true, showGlobalRoutingModels: false, includeModels: [], excludeModels: [], syncOnStartup: true, modelCacheTtlMinutes: 60, autoSyncIntervalMs: 300000, lastSuccessfulSyncAt: 0, serverUrl: "http://localhost:20128", providerName: "omni", apiKey: "secret" },
	);
	expect(models.some((model) => model.id === "openai/gpt-5")).toBe(true);
});
