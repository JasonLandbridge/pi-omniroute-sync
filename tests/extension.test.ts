import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadSettings, saveSettings, settingsPath, type OmniSettings } from "../src/config.ts";
import type { OmniContext, OmniPI } from "../src/contracts.ts";

const providerMocks = vi.hoisted(() => ({
	AUTO_MODELS: ["auto"],
	checkHealth: vi.fn().mockResolvedValue(true),
	probeHealth: vi.fn().mockResolvedValue({ ok: true, unreachable: false }),
	checkModelsEndpoint: vi.fn().mockResolvedValue(true),
	discoverModels: vi.fn().mockResolvedValue([]),
	isSyncStale: vi.fn().mockReturnValue(false),
	registerOmniProvider: vi.fn().mockResolvedValue([]),
	reloadOmniProvider: vi.fn(),
	setInferenceApi: vi.fn(),
	testChat: vi.fn().mockResolvedValue("ok"),
	transformProviderPayload: vi.fn((payload) => payload),
}));

vi.mock("../src/provider.ts", () => providerMocks);

import { createOmniExtension } from "../src/extension.ts";

const baseSettings: OmniSettings = {
	serverUrl: "http://localhost:20128",
	providerName: "omni",
	onlyShowUsableModels: true,
	showGlobalRoutingModels: true,
	includeModels: [],
	excludeModels: [],
	syncOnStartup: false,
	modelCacheTtlMinutes: 60,
	autoSyncIntervalSeconds: 60,
	showGatewayTokensPerSecond: true,
	lastSuccessfulSyncAt: 0,
	onUnreachable: "none",
	fallbackModel: "",
	apiKey: "",
};

type Handler = (...args: any[]) => any;

type FakePi = OmniPI & {
	events: Map<string, Handler>;
	commands: Map<string, { handler: Handler }>;
};

function fakePi(): FakePi {
	const events = new Map<string, Handler>();
	const commands = new Map<string, { handler: Handler }>();
	const pi = {
		events,
		commands,
		registerProvider: vi.fn(),
		registerTool: vi.fn(),
		registerCommand: vi.fn((name: string, options: { handler: Handler }) => commands.set(name, options)),
		on: vi.fn((event: string, handler: Handler) => events.set(event, handler)),
	};
	return pi as unknown as FakePi;
}

function context(uiOverrides: Partial<OmniContext["ui"]> = {}): OmniContext {
	return {
		hasUI: true,
		mode: "tui",
		signal: undefined,
		ui: {
			input: vi.fn().mockResolvedValue(undefined),
			confirm: vi.fn().mockResolvedValue(false),
			custom: vi.fn(),
			notify: vi.fn(),
			setStatus: vi.fn(),
			...uiOverrides,
		},
	};
}

async function createExtension(home: string, pi = fakePi()): Promise<FakePi> {
	vi.stubEnv("PI_HOME", home);
	await createOmniExtension(pi, {
		homeEnvVar: "PI_HOME",
		defaultHome: "~/.pi/agent",
		matchesKey: (data, key) => ({ "\t": "tab", "\r": "enter", "\x1b": "escape", "\x15": "ctrl+u", "\x03": "ctrl+c" }[data] ?? data) === key,
		createInput: (initialValue) => {
			let value = initialValue;
			let onSubmit: ((submitted: string) => void) | undefined;
			let onEscape: (() => void) | undefined;
			return {
				render: () => [value],
				invalidate: () => {},
				get onSubmit() { return onSubmit; },
				set onSubmit(handler: ((submitted: string) => void) | undefined) { onSubmit = handler; },
				get onEscape() { return onEscape; },
				set onEscape(handler: (() => void) | undefined) { onEscape = handler; },
				getValue: () => value,
				setValue: (next) => { value = next; },
				handleInput: (data) => {
					if (data === "\r") return onSubmit?.(value);
					if (data === "\x1b") return onEscape?.();
					value = data === "\x15" ? "" : value + data;
				},
			};
		},
	});
	return pi;
}

beforeEach(() => {
	vi.useFakeTimers();
	providerMocks.checkHealth.mockResolvedValue(true);
	providerMocks.probeHealth.mockResolvedValue({ ok: true, unreachable: false });
	providerMocks.checkModelsEndpoint.mockResolvedValue(true);
	providerMocks.isSyncStale.mockReturnValue(false);
	providerMocks.registerOmniProvider.mockReset().mockResolvedValue([]);
	providerMocks.reloadOmniProvider.mockClear();
	providerMocks.setInferenceApi.mockClear();
	providerMocks.transformProviderPayload.mockClear();
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

describe("autosync lifecycle", () => {
	it("starts autosync after setup succeeds", async () => {
		const home = mkdtempSync(join(tmpdir(), "pi-omni-extension-"));
		const pi = fakePi();
		const ui = context({ input: vi.fn().mockResolvedValueOnce(baseSettings.serverUrl).mockResolvedValueOnce("") });
		await createExtension(home, pi);

		await pi.commands.get("omni")!.handler("setup", ui);
		expect(providerMocks.checkModelsEndpoint).toHaveBeenCalledOnce();
		expect(providerMocks.registerOmniProvider).toHaveBeenCalledOnce();

		vi.advanceTimersByTime(300_000);
		await vi.waitFor(() => expect(providerMocks.registerOmniProvider).toHaveBeenCalledTimes(2));
		pi.events.get("session_shutdown")!();
	});

	it("refreshes while a configured session is running and stops on shutdown", async () => {
		const home = mkdtempSync(join(tmpdir(), "pi-omni-extension-"));
		saveSettings(home, baseSettings);
		const pi = await createExtension(home);
		const sessionStart = pi.events.get("session_start")!;
		const sessionShutdown = pi.events.get("session_shutdown")!;
		const ui = context();

		await sessionStart({}, ui);
		vi.advanceTimersByTime(60_000);
		await vi.waitFor(() => expect(providerMocks.registerOmniProvider).toHaveBeenCalledOnce());

		sessionShutdown();
		vi.advanceTimersByTime(120_000);
		expect(providerMocks.registerOmniProvider).toHaveBeenCalledOnce();
	});

	it("uses but does not save an environment-only key during setup", async () => {
		const home = mkdtempSync(join(tmpdir(), "pi-omni-extension-"));
		vi.stubEnv("OMNIROUTE_API_KEY", "environment-secret");
		const pi = await createExtension(home);
		const ui = context({ input: vi.fn().mockResolvedValueOnce(baseSettings.serverUrl).mockResolvedValueOnce("") });

		await pi.commands.get("omni")!.handler("setup", ui);

		expect(providerMocks.checkModelsEndpoint).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "environment-secret" }), undefined);
		expect(providerMocks.registerOmniProvider).toHaveBeenCalledWith(
			pi,
			home,
			expect.objectContaining({ apiKey: "environment-secret" }),
			expect.anything(),
			undefined,
		);
		expect(JSON.parse(readFileSync(settingsPath(home), "utf8"))).toMatchObject({ apiKey: "" });
		pi.events.get("session_shutdown")!();
	});

	it("applies an interval changed in the config dialog to the running session", async () => {
		const home = mkdtempSync(join(tmpdir(), "pi-omni-extension-"));
		saveSettings(home, baseSettings);
		const pi = fakePi();
		const ui = context({
			custom: vi.fn(async (factory: any): Promise<any> => {
				let result: OmniSettings | undefined;
				const component = await factory(
					{ requestRender: vi.fn() },
					{ fg: (_color: unknown, text: string) => text, bold: (text: string) => text },
					{},
					(value: OmniSettings | undefined) => { result = value; },
				);
				component.handleInput("\t");
				for (let index = 0; index < 8; index++) component.handleInput("j");
				component.handleInput("\r");
				component.handleInput("\x15");
				component.handleInput("0");
				component.handleInput("\r");
				component.handleInput("\x1b");
				return result;
			}) as unknown as OmniContext["ui"]["custom"],
		});
		await createExtension(home, pi);

		await pi.commands.get("omni")!.handler("config", ui);
		expect(JSON.parse(readFileSync(settingsPath(home), "utf8"))).toMatchObject({ autoSyncIntervalSeconds: 0 });
		const callsBeforeAdvance = providerMocks.registerOmniProvider.mock.calls.length;
		vi.advanceTimersByTime(120_000);
		expect(providerMocks.registerOmniProvider).toHaveBeenCalledTimes(callsBeforeAdvance);
	});

	it("turns autosync off immediately when the command sets zero", async () => {
		const home = mkdtempSync(join(tmpdir(), "pi-omni-extension-"));
		saveSettings(home, baseSettings);
		const pi = await createExtension(home);
		const ui = context();
		await pi.events.get("session_start")!({}, ui);
		await pi.commands.get("omni")!.handler("autosync off", ui);

		vi.advanceTimersByTime(120_000);
		expect(providerMocks.registerOmniProvider).not.toHaveBeenCalled();
		pi.events.get("session_shutdown")!();
	});

	it("does not persist an environment-only API key when changing the interval", async () => {
		const home = mkdtempSync(join(tmpdir(), "pi-omni-extension-"));
		saveSettings(home, { ...baseSettings, apiKey: "" });
		vi.stubEnv("OMNIROUTE_API_KEY", "environment-secret");
		const pi = await createExtension(home);

		await pi.commands.get("omni")!.handler("autosync 120", context());

		const saved = JSON.parse(readFileSync(settingsPath(home), "utf8")) as OmniSettings;
		expect(saved.autoSyncIntervalSeconds).toBe(120);
		expect(saved.apiKey).toBe("");
		expect(loadSettings(home).apiKey).toBe("");
		pi.events.get("session_shutdown")!();
	});

	it("shows effective fallback settings without persisting environment overrides", async () => {
		const home = mkdtempSync(join(tmpdir(), "pi-omni-extension-"));
		saveSettings(home, { ...baseSettings, onUnreachable: "none", fallbackModel: "" });
		vi.stubEnv("OMNIROUTE_ON_UNREACHABLE", "host-fallback");
		vi.stubEnv("OMNIROUTE_FALLBACK_MODEL", "anthropic/claude-sonnet-4");
		const pi = fakePi();
		const ui = context({
			custom: vi.fn(async (factory: any): Promise<any> => {
				let result: OmniSettings | undefined;
				const component = await factory({ requestRender: vi.fn() }, { fg: (_color: unknown, text: string) => text, bold: (text: string) => text }, {}, (value: OmniSettings | undefined) => { result = value; });
				component.handleInput("\x1b");
				return result;
			}) as unknown as OmniContext["ui"]["custom"],
		});
		await createExtension(home, pi);

		await pi.commands.get("omni")!.handler("config", ui);

		expect(JSON.parse(readFileSync(settingsPath(home), "utf8"))).toMatchObject({ onUnreachable: "none", fallbackModel: "" });
	});
});

describe("provider request compatibility hook", () => {
	it("registers a request payload hook with the current model context", async () => {
		const home = mkdtempSync(join(tmpdir(), "pi-omni-extension-"));
		const pi = await createExtension(home);
		const hook = pi.events.get("before_provider_request")!;
		const payload = { model: "gpt-5" };
		const model = { provider: "omni", omitMaxOutputTokens: true };
		const ctx = { ...context(), model };

		await hook({ payload }, ctx);

		expect(providerMocks.transformProviderPayload).toHaveBeenCalledWith(payload, model, "omni");
	});
});

describe("unreachable fallback lifecycle", () => {
	it("switches before the next turn when the configured server is unreachable", async () => {
		const home = mkdtempSync(join(tmpdir(), "pi-omni-extension-"));
		saveSettings(home, { ...baseSettings, onUnreachable: "host-fallback", fallbackModel: "anthropic/claude-sonnet-4" });
		providerMocks.probeHealth.mockResolvedValue({ ok: false, unreachable: true });
		const pi = await createExtension(home);
		pi.setModel = vi.fn().mockResolvedValue(true);
		const fallback = { provider: "anthropic", id: "claude-sonnet-4" };
		const registry = {
			find(provider: string, id: string) {
				return provider === fallback.provider && id === fallback.id ? fallback : undefined;
			},
		};
		const ctx = { ...context(), model: { provider: "omni", id: "auto" }, modelRegistry: registry };

		await pi.events.get("before_agent_start")!({}, ctx);

		expect(pi.setModel).toHaveBeenCalledWith(fallback);
	});

	it("switches after a thrown OmniRoute connection failure", async () => {
		const home = mkdtempSync(join(tmpdir(), "pi-omni-extension-"));
		saveSettings(home, { ...baseSettings, onUnreachable: "host-fallback", fallbackModel: "anthropic/claude-sonnet-4" });
		const pi = await createExtension(home);
		pi.setModel = vi.fn().mockResolvedValue(true);
		const fallback = { provider: "anthropic", id: "claude-sonnet-4" };
		const registry = {
			find(provider: string, id: string) {
				return provider === fallback.provider && id === fallback.id ? fallback : undefined;
			},
		};
		const ctx = { ...context(), model: { provider: "omni", id: "auto" }, modelRegistry: registry };

		await pi.events.get("agent_end")!({
			messages: [{ role: "assistant", provider: "omni", stopReason: "error", errorMessage: "fetch failed: ECONNREFUSED" }],
		}, ctx);
		expect(pi.setModel).not.toHaveBeenCalled();
		await pi.events.get("agent_settled")!({}, ctx);

		expect(pi.setModel).toHaveBeenCalledWith(fallback);
	});

	it("hops after an HTTP failure when the agent finally settles", async () => {
		const home = mkdtempSync(join(tmpdir(), "pi-omni-extension-"));
		saveSettings(home, { ...baseSettings, onUnreachable: "host-fallback", fallbackModel: "anthropic/claude-sonnet-4" });
		const pi = await createExtension(home);
		pi.setModel = vi.fn().mockResolvedValue(true);
		const fallback = { provider: "anthropic", id: "claude-sonnet-4" };
		const registry = { find: vi.fn(() => fallback) };
		const ctx = { ...context(), model: { provider: "omni", id: "auto" }, modelRegistry: registry };

		await pi.events.get("after_provider_response")!({ status: 503, headers: {} }, ctx);
		expect(pi.setModel).not.toHaveBeenCalled();
		await pi.events.get("agent_end")!({
			messages: [{ role: "assistant", provider: "omni", stopReason: "error", errorMessage: "gateway request failed" }],
		}, ctx);
		await pi.events.get("agent_settled")!({}, ctx);

		expect(pi.setModel).toHaveBeenCalledWith(fallback);
	});

	it("does not hop when a retry recovers on OmniRoute", async () => {
		const home = mkdtempSync(join(tmpdir(), "pi-omni-extension-"));
		saveSettings(home, { ...baseSettings, onUnreachable: "host-fallback", fallbackModel: "anthropic/claude-sonnet-4" });
		const pi = await createExtension(home);
		pi.setModel = vi.fn().mockResolvedValue(true);
		const ctx = { ...context(), model: { provider: "omni", id: "auto" } };

		await pi.events.get("agent_end")!({
			messages: [{ role: "assistant", provider: "omni", stopReason: "error", errorMessage: "Connection error." }],
		}, ctx);
		await pi.events.get("agent_end")!({
			messages: [{ role: "assistant", provider: "omni", stopReason: "stop" }],
		}, ctx);
		await pi.events.get("agent_settled")!({}, ctx);

		expect(pi.setModel).not.toHaveBeenCalled();
	});

	it("does not hop for a reachable but unhealthy gateway", async () => {
		const home = mkdtempSync(join(tmpdir(), "pi-omni-extension-"));
		saveSettings(home, { ...baseSettings, onUnreachable: "host-fallback", fallbackModel: "anthropic/claude-sonnet-4" });
		providerMocks.probeHealth.mockResolvedValue({ ok: false, unreachable: false });
		const pi = await createExtension(home);
		pi.setModel = vi.fn().mockResolvedValue(true);
		const ctx = { ...context(), model: { provider: "omni", id: "auto" } };

		await pi.events.get("turn_start")!({}, ctx);

		expect(pi.setModel).not.toHaveBeenCalled();
	});

	it("does not hop for an aborted turn", async () => {
		const home = mkdtempSync(join(tmpdir(), "pi-omni-extension-"));
		saveSettings(home, { ...baseSettings, onUnreachable: "host-fallback", fallbackModel: "anthropic/claude-sonnet-4" });
		const pi = await createExtension(home);
		pi.setModel = vi.fn().mockResolvedValue(true);
		const ctx = { ...context(), signal: AbortSignal.abort(), model: { provider: "omni", id: "auto" } };

		await pi.events.get("agent_end")!({
			messages: [{ role: "assistant", provider: "omni", stopReason: "error", errorMessage: "Connection error." }],
		}, ctx);
		await pi.events.get("agent_settled")!({}, ctx);

		expect(pi.setModel).not.toHaveBeenCalled();
	});

	it("does not mark OmniRoute down for another provider's failed response", async () => {
		const home = mkdtempSync(join(tmpdir(), "pi-omni-extension-"));
		saveSettings(home, baseSettings);
		const pi = await createExtension(home);
		const ui = context();
		await pi.events.get("after_provider_response")!({ status: 503, headers: {} }, { ...ui, model: { provider: "anthropic", id: "claude-sonnet-4" } });

		expect(ui.ui.setStatus).not.toHaveBeenCalledWith("omni", "OmniRoute unreachable");
	});
});
