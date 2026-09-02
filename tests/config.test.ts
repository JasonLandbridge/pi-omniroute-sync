import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, loadSettings, sanitizeConfig, sanitizeSettings, saveConfig, settingsPath } from "../src/config.ts";

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
			autoSyncIntervalMs: 300000,
			lastSuccessfulSyncAt: 0,
		});
	});
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
			autoSyncIntervalMs: 300000,
			lastSuccessfulSyncAt: 0,
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
			autoSyncIntervalMs: 300000,
			lastSuccessfulSyncAt: 0,
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
			autoSyncIntervalMs: 300000,
			lastSuccessfulSyncAt: 0,
			apiKey: "secret",
		});
		expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(loadConfig(agentHome)).toEqual({ serverUrl: "http://example.com", providerName: "custom", apiKey: "secret" });
	});
});
