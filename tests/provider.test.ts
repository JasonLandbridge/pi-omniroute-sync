import { expect, it } from "vitest";
import { globMatches, isGlobalRoutingModel, isSyncStale, modelCost, normalizePersistedModels, PROVIDER_COMPAT, shouldIncludeModel, usableProviderAliases } from "../src/provider.ts";

it("uses OmniRoute's supported session-affinity header", () => {
	expect(PROVIDER_COMPAT.sessionAffinityFormat).toBe("openrouter");
});

it("normalizes legacy persisted models for Responses and cost tiers", () => {
	const [model] = normalizePersistedModels([{ id: "codex/gpt-5", name: "GPT-5" }, {}, { id: "" }]);

	expect(model.api).toBe("openai-responses");
	expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tiers: [] });
	expect(normalizePersistedModels([{}, { id: "" }])).toEqual([]);
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
