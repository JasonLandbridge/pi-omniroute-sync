import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, loadHopSettings, loadProbeConfig, loadSettings, sanitizeConfig, sanitizeSettings, saveConfig, settingsPath, type OmniSettings } from "../src/config.ts";

describe("sanitizeConfig", () => {
	it("uses defaults when nothing is provided", () => {
		expect(sanitizeConfig({})).toEqual({
			serverUrl: "http://localhost:20128",
			apiKey: "",
			providerName: "omni",
		});
	});

	it("trims trailing slashes and strips the /v1 suffix", () => {
		expect(sanitizeConfig({ serverUrl: "http://example.com/v1/" }).serverUrl).toBe("http://example.com");
	});

	it("falls back to the default provider name when blank", () => {
		expect(sanitizeConfig({ providerName: "  " }).providerName).toBe("omni");
	});
});

describe("sanitizeSettings", () => {
	it("drops invalid array values and non-finite or negative timestamps", () => {
		expect(sanitizeSettings({
			includeModels: ["openai/*", 42] as string[],
			excludeModels: [null, "*/legacy"] as string[],
			modelCacheTtlMinutes: Number.NaN,
			lastSuccessfulSyncAt: -1,
		})).toMatchObject({
			includeModels: ["openai/*"],
			excludeModels: ["*/legacy"],
			modelCacheTtlMinutes: 60,
			autoSyncIntervalSeconds: 300,
			lastSuccessfulSyncAt: 0,
		});
	});
});

it("normalizes persisted auto-sync values at the settings boundary", () => {
	expect(sanitizeSettings({ autoSyncIntervalSeconds: 12_345.9 })).toMatchObject({ autoSyncIntervalSeconds: 12_345 });
	expect(sanitizeSettings({ autoSyncIntervalSeconds: 0 })).toMatchObject({ autoSyncIntervalSeconds: 0 });
	expect(sanitizeSettings({ autoSyncIntervalSeconds: -1 })).toMatchObject({ autoSyncIntervalSeconds: 300 });
	expect(sanitizeSettings({ autoSyncIntervalSeconds: Number.NaN })).toMatchObject({ autoSyncIntervalSeconds: 300 });
	expect(sanitizeSettings({ autoSyncIntervalSeconds: "12345" as unknown as number })).toMatchObject({ autoSyncIntervalSeconds: 300 });
	expect(sanitizeSettings({ autoSyncIntervalMs: 120_000 } as Partial<OmniSettings> & { autoSyncIntervalMs: number })).toMatchObject({ autoSyncIntervalSeconds: 120 });
	expect(sanitizeSettings({ showGatewayTokensPerSecond: false }).showGatewayTokensPerSecond).toBe(false);
});

describe("loadSettings", () => {
	it("uses an extension-owned settings path", () => {
		expect(settingsPath("/agent")).toBe("/agent/extensions/pi-omniroute-sync/settings.json");
	});

	it("uses secure settings defaults", () => {
		expect(loadSettings(mkdtempSync(join(tmpdir(), "pi-omni-settings-")))).toEqual({
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
		});
	});

	it("uses defaults for malformed settings", () => {
		const agentHome = mkdtempSync(join(tmpdir(), "pi-omni-settings-"));
		saveConfig(agentHome, { serverUrl: "http://localhost:20128", providerName: "omni", apiKey: "secret" });
		const path = settingsPath(agentHome);
		writeFileSync(path, "{");

		expect(loadSettings(agentHome)).toEqual({
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
		});
	});
});

describe("saveConfig", () => {
	it("writes one secured settings file and preserves the toggle", () => {
		const agentHome = mkdtempSync(join(tmpdir(), "pi-omni-config-"));

		const settings = loadSettings(agentHome);
		settings.onlyShowUsableModels = false;
		saveConfig(agentHome, { serverUrl: "http://example.com/v1/", providerName: "custom", apiKey: "secret" }, settings);

		const path = settingsPath(agentHome);
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
			serverUrl: "http://example.com",
			providerName: "custom",
			onlyShowUsableModels: false,
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
			apiKey: "secret",
		});
		expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(loadConfig(agentHome)).toEqual({ serverUrl: "http://example.com", providerName: "custom", apiKey: "secret" });
	});
});

describe("unreachable hop settings", () => {
	it("accepts host-fallback and a host model id", () => {
		expect(sanitizeSettings({
			onUnreachable: "host-fallback",
			fallbackModel: " anthropic/claude-sonnet-4 ",
		})).toMatchObject({
			onUnreachable: "host-fallback",
			fallbackModel: "anthropic/claude-sonnet-4",
		});
	});

	it("rejects unknown onUnreachable values", () => {
		expect(sanitizeSettings({ onUnreachable: "switch-provider" as never }).onUnreachable).toBe("none");
	});

	it("probes the configured settings serverUrl even when OMNIROUTE_URL is unset", () => {
		const agentHome = mkdtempSync(join(tmpdir(), "pi-omni-probe-"));
		saveConfig(agentHome, { serverUrl: "http://gateway.example:20128", providerName: "omni", apiKey: "" });
		const previous = process.env.OMNIROUTE_URL;
		delete process.env.OMNIROUTE_URL;
		try {
			expect(loadProbeConfig(agentHome).serverUrl).toBe("http://gateway.example:20128");
		} finally {
			if (previous === undefined) delete process.env.OMNIROUTE_URL;
			else process.env.OMNIROUTE_URL = previous;
		}
	});

	it("prefers the configured settings serverUrl over OMNIROUTE_URL for probes", () => {
		const agentHome = mkdtempSync(join(tmpdir(), "pi-omni-probe-env-"));
		saveConfig(agentHome, { serverUrl: "http://configured.example", providerName: "omni", apiKey: "" });
		const previous = process.env.OMNIROUTE_URL;
		process.env.OMNIROUTE_URL = "http://env-only.example";
		try {
			expect(loadConfig(agentHome).serverUrl).toBe("http://env-only.example");
			expect(loadProbeConfig(agentHome).serverUrl).toBe("http://configured.example");
		} finally {
			if (previous === undefined) delete process.env.OMNIROUTE_URL;
			else process.env.OMNIROUTE_URL = previous;
		}
	});

	it("reads hop overrides from the environment without writing them to settings", () => {
		const agentHome = mkdtempSync(join(tmpdir(), "pi-omni-hop-"));
		saveConfig(agentHome, { serverUrl: "http://localhost:20128", providerName: "omni", apiKey: "" });
		const previousAction = process.env.OMNIROUTE_ON_UNREACHABLE;
		const previousModel = process.env.OMNIROUTE_FALLBACK_MODEL;
		process.env.OMNIROUTE_ON_UNREACHABLE = "host-fallback";
		process.env.OMNIROUTE_FALLBACK_MODEL = "openai/gpt-5";
		try {
			expect(loadHopSettings(agentHome)).toEqual({
				onUnreachable: "host-fallback",
				fallbackModel: "openai/gpt-5",
			});
			expect(loadSettings(agentHome).onUnreachable).toBe("none");
		} finally {
			if (previousAction === undefined) delete process.env.OMNIROUTE_ON_UNREACHABLE;
			else process.env.OMNIROUTE_ON_UNREACHABLE = previousAction;
			if (previousModel === undefined) delete process.env.OMNIROUTE_FALLBACK_MODEL;
			else process.env.OMNIROUTE_FALLBACK_MODEL = previousModel;
		}
	});
});
