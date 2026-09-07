import { Input, matchesKey } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { ConfigDialog, summarizeModels, type KeyMatcher } from "../src/config-dialog.ts";
import type { OmniSettings } from "../src/config.ts";
import type { OmniTheme, ProviderModelConfig } from "../src/contracts.ts";

const theme: OmniTheme = { fg: (_color, text) => text, bold: (text) => text };
const matchKey: KeyMatcher = (data, key) => matchesKey(data, key as never);
const baseSettings: OmniSettings = {
	serverUrl: "http://localhost:20128",
	providerName: "omni",
	onlyShowUsableModels: true,
	showGlobalRoutingModels: true,
	includeModels: [],
	excludeModels: [],
	syncOnStartup: true,
	modelCacheTtlMinutes: 60,
	autoSyncIntervalSeconds: 300,
	lastSuccessfulSyncAt: 0,
	apiKey: "secret",
};
const UP = ["\x1b[A", "\x1bOA", "\x1b[57419u", "\x1b[1;1A"];
const DOWN = ["\x1b[B", "\x1bOB", "\x1b[57420u", "\x1b[1;1B"];
const LEFT = ["\x1b[D", "\x1bOD", "\x1b[57417u", "\x1b[1;1D"];
const RIGHT = ["\x1b[C", "\x1bOC", "\x1b[57418u", "\x1b[1;1C"];
const ESCAPE = ["\x1b", "\x1b[27u", "\x1b[27;1;27~"];
const ENTER = ["\r", "\x1b[13u"];
const SPACE = [" ", "\x1b[32u"];
const BACKSPACE = ["\x7f", "\x1b[127u"];

function model(id: string, options: Partial<ProviderModelConfig> = {}): ProviderModelConfig {
	return {
		id,
		name: id,
		api: "openai-responses",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tiers: [] },
		contextWindow: 128_000,
		maxTokens: 16_384,
		...options,
	};
}

function dialog(done = vi.fn(), onSync?: () => Promise<{ summary?: ReturnType<typeof summarizeModels>; error?: string }>): ConfigDialog {
	return new ConfigDialog({ ...baseSettings }, summarizeModels([model("auto")]), undefined, theme, done, matchKey, onSync, (initialValue) => {
		const input = new Input();
		if (initialValue) input.handleInput(initialValue);
		return input;
	});
}

function goConfig(component: ConfigDialog): void {
	component.handleInput("\t");
}

function selectToggle(component: ConfigDialog): void {
	goConfig(component);
	component.handleInput("j");
	component.handleInput("j");
}

function selectedLine(component: ConfigDialog): string {
	return component.render(100).find((line) => line.includes("› ")) ?? "";
}

function rendered(component: ConfigDialog): string {
	return component.render(100).join("\n");
}

function visibleWidth(value: string): number {
	return value.replace(/\u001b\[[0-9;]*m/g, "").length;
}

describe("model summary", () => {
	it("summarizes groups and capabilities", () => {
		expect(summarizeModels([
			model("auto"),
			model("openai/gpt-5", { reasoning: true, contextWindow: 400_000 }),
			model("google/gemini", { input: ["text", "image"], contextWindow: 1_000_000 }),
		])).toEqual({ total: 3, auto: 1, providerGroups: 2, reasoning: 1, vision: 1, minContext: 128_000, maxContext: 1_000_000 });
	});

	it("handles an empty catalog", () => {
		expect(summarizeModels([])).toEqual({ total: 0, auto: 0, providerGroups: 0, reasoning: 0, vision: 0, minContext: 0, maxContext: 0 });
	});
});

describe("navigation", () => {
	it.each([...RIGHT, "\t", "\x1b[9u"])("opens Config with %j", (key) => {
		const component = dialog();
		component.handleInput(key);
		expect(rendered(component)).toContain("[ Config ]");
	});

	it.each(LEFT)("returns to Summary with %j", (key) => {
		const component = dialog();
		goConfig(component);
		component.handleInput(key);
		expect(rendered(component)).toContain("[ Summary ]");
	});

	it.each(DOWN)("moves down with %j", (key) => {
		const component = dialog();
		goConfig(component);
		component.handleInput(key);
		expect(selectedLine(component)).toContain("Provider name");
	});

	it.each(UP)("moves up with %j", (key) => {
		const component = dialog();
		selectToggle(component);
		component.handleInput(key);
		expect(selectedLine(component)).toContain("Provider name");
	});

	it("supports j/k and keeps provider read-only", () => {
		const done = vi.fn();
		const component = dialog(done);
		goConfig(component);
		component.handleInput("j");
		expect(selectedLine(component)).toContain("Provider name");
		component.handleInput("\r");
		expect(done).not.toHaveBeenCalled();
		component.handleInput("k");
		expect(selectedLine(component)).toContain("Server URL");
	});
});

describe("staged boolean control", () => {
	it.each([...SPACE, ...ENTER])("toggles locally with %j without closing", (key) => {
		const done = vi.fn();
		const component = dialog(done);
		selectToggle(component);
		component.handleInput(key);
		expect(rendered(component)).toContain("● OFF");
		expect(rendered(component)).toContain("draft");
		expect(done).not.toHaveBeenCalled();
	});

	it("toggles repeatedly without async work or recreation", () => {
		const done = vi.fn();
		const component = dialog(done);
		selectToggle(component);
		component.handleInput(" ");
		component.handleInput(" ");
		expect(rendered(component)).toContain("● ON");
		expect(done).not.toHaveBeenCalled();
	});

	it("independently hides global routing models in the draft", () => {
		const done = vi.fn();
		const component = dialog(done);
		selectToggle(component);
		component.handleInput("j");
		component.handleInput(" ");
		expect(rendered(component)).toContain("Global routing models hidden in draft");
		component.handleInput("\x1b");
		expect(done).toHaveBeenCalledWith({ ...baseSettings, showGlobalRoutingModels: false });
	});

	it("gives Space precedence over an overlapping Tab match", () => {
		const done = vi.fn();
		const overlap = (data: string, key: string) => matchKey(data, key) || (data === "OVERLAP" && (key === "space" || key === "tab"));
		const component = new ConfigDialog({ ...baseSettings }, summarizeModels([]), undefined, theme, done, overlap, undefined, (initialValue) => {
		const input = new Input();
		if (initialValue) input.handleInput(initialValue);
		return input;
	});
		component.handleInput("]");
		component.handleInput("j");
		component.handleInput("j");
		component.handleInput("OVERLAP");
		expect(rendered(component)).toContain("[ Config ]");
		expect(rendered(component)).toContain("● OFF");
		expect(done).not.toHaveBeenCalled();
	});

	it.each(SPACE)("Space is inert on non-boolean rows for %j", (key) => {
		const done = vi.fn();
		const component = dialog(done);
		goConfig(component);
		component.handleInput(key);
		expect(selectedLine(component)).toContain("Server URL");
		expect(done).not.toHaveBeenCalled();
	});
});

describe("inline field editing", () => {
	it("edits URL in the same overlay and stages it", () => {
		const done = vi.fn();
		const component = dialog(done);
		goConfig(component);
		component.handleInput("\r");
		for (let index = 0; index < baseSettings.serverUrl.length; index++) component.handleInput("\x7f");
		component.handleInput("http://example.test:1234");
		component.handleInput("\r");
		expect(rendered(component)).toContain("http://example.test:1234");
		expect(rendered(component)).toContain("updated in draft");
		expect(done).not.toHaveBeenCalled();
	});

	it("rejects an invalid URL while keeping the editor open", () => {
		const component = dialog();
		goConfig(component);
		component.handleInput("\r");
		component.handleInput("\x15");
		component.handleInput("invalid");
		component.handleInput("\r");
		expect(rendered(component)).toContain("Invalid server URL");
		expect(rendered(component)).toContain("invalid");
	});

	it.each(ESCAPE)("Escape cancels only the active URL edit for %j", (key) => {
		const done = vi.fn();
		const component = dialog(done);
		goConfig(component);
		component.handleInput("\r");
		component.handleInput("changed");
		component.handleInput(key);
		expect(rendered(component)).toContain("http://localhost:20128");
		expect(rendered(component)).toContain("Edit cancelled");
		expect(done).not.toHaveBeenCalled();
	});

	it.each(BACKSPACE)("handles backspace encoding %j", (key) => {
		const component = dialog();
		goConfig(component);
		component.handleInput("\r");
		component.handleInput("x");
		component.handleInput(key);
		expect(rendered(component)).not.toContain("20128x");
	});

	it("trims and removes empty model glob entries", () => {
		const done = vi.fn();
		const component = dialog(done);
		goConfig(component);
		for (let index = 0; index < 4; index++) component.handleInput("j");
		component.handleInput("\r");
		component.handleInput("openai/*, , google/* ");
		component.handleInput("\r");
		component.handleInput("\x1b");
		expect(done).toHaveBeenCalledWith({ ...baseSettings, includeModels: ["openai/*", "google/*"] });
	});

	it("rejects a negative cache TTL and keeps the editor open", () => {
		const component = dialog();
		goConfig(component);
		for (let index = 0; index < 7; index++) component.handleInput("j");
		component.handleInput("\r");
		component.handleInput("\x15");
		component.handleInput("-1");
		component.handleInput("\r");
		expect(rendered(component)).toContain("Cache TTL must be a non-negative number");
		expect(rendered(component)).toContain("-1");
	});

	it("edits the auto-sync interval in seconds", () => {
		const done = vi.fn();
		const component = dialog(done);
		goConfig(component);
		for (let index = 0; index < 8; index++) component.handleInput("j");
		component.handleInput("\r");
		component.handleInput("\x15");
		component.handleInput("120");
		component.handleInput("\r");
		component.handleInput("\x1b");
		expect(done).toHaveBeenCalledWith({ ...baseSettings, autoSyncIntervalSeconds: 120 });
	});

	it("rejects a negative auto-sync interval and keeps the editor open", () => {
		const component = dialog();
		goConfig(component);
		for (let index = 0; index < 8; index++) component.handleInput("j");
		component.handleInput("\r");
		component.handleInput("\x15");
		component.handleInput("-1");
		component.handleInput("\r");
		expect(rendered(component)).toContain("Auto-sync interval must be a non-negative number of seconds");
		expect(rendered(component)).toContain("-1");
	});

	it("masks API-key editing and stages the replacement", () => {
		const done = vi.fn();
		const component = dialog(done);
		goConfig(component);
		for (let index = 0; index < 9; index++) component.handleInput("j");
		component.handleInput("\r");
		component.handleInput("new-secret");
		expect(rendered(component)).not.toContain("new-secret");
		expect(rendered(component)).toContain("••••••••••");
		component.handleInput("\r");
		expect(done).not.toHaveBeenCalled();
	});

	it("clears the API key in the draft without a nested dialog", () => {
		const done = vi.fn();
		const component = dialog(done);
		goConfig(component);
		for (let index = 0; index < 10; index++) component.handleInput("j");
		component.handleInput("\r");
		expect(rendered(component)).toContain("already empty");
		expect(done).not.toHaveBeenCalled();
	});
});

describe("save and cancel", () => {
	it("does not close or save for ordinary printable input outside an editor", () => {
		const done = vi.fn();
		const component = dialog(done);
		component.handleInput("q");
		expect(done).not.toHaveBeenCalled();
		expect(rendered(component)).toContain("[ Summary ]");
	});

	it.each(ESCAPE)("Escape outside editing returns the complete draft once for %j", (key) => {
		const done = vi.fn();
		const component = dialog(done);
		selectToggle(component);
		component.handleInput(" ");
		component.handleInput(key);
		expect(done).toHaveBeenCalledTimes(1);
		expect(done).toHaveBeenCalledWith({ ...baseSettings, onlyShowUsableModels: false });
	});

	it("Ctrl+C discards all draft changes", () => {
		const done = vi.fn();
		const component = dialog(done);
		selectToggle(component);
		component.handleInput(" ");
		component.handleInput("\x03");
		expect(done).toHaveBeenCalledWith(undefined);
	});

	it("footer clearly distinguishes save and cancel", () => {
		const component = dialog();
		goConfig(component);
		expect(rendered(component)).toContain("esc save & close");
		expect(rendered(component)).toContain("ctrl+c cancel");
	});
});

describe("manual sync", () => {
	it("runs in place and shows success without closing", async () => {
		const done = vi.fn();
		const onSync = vi.fn(async () => ({ summary: summarizeModels([model("auto"), model("openai/gpt")]) }));
		const component = dialog(done, onSync);
		component.handleInput("s");
		expect(rendered(component)).toContain("Syncing models");
		await vi.waitFor(() => expect(rendered(component)).toContain("Models synced successfully"));
		expect(rendered(component)).toContain("Models             2");
		expect(done).not.toHaveBeenCalled();
	});

	it("shows sync failure without closing", async () => {
		const done = vi.fn();
		const component = dialog(done, async () => ({ error: "offline" }));
		component.handleInput("\r");
		await vi.waitFor(() => expect(rendered(component)).toContain("Sync failed: offline"));
		expect(done).not.toHaveBeenCalled();
	});
});

describe("rendering", () => {
	it("renders header, sections, status, footer, and no stored secret", () => {
		const component = dialog();
		goConfig(component);
		const output = rendered(component);
		expect(output).toContain("OmniRoute");
		expect(output).toContain("Connection");
		expect(output).toContain("Model visibility");
		expect(output).toContain("Auto-sync interval");
		expect(output).toContain("Credentials");
		expect(output).not.toContain("secret");
		expect(output).toContain("┌");
		expect(output).toContain("└");
	});

	it("renders live-fetch errors", () => {
		const component = new ConfigDialog({ ...baseSettings }, undefined, "offline", theme, vi.fn(), matchKey, undefined, (initialValue) => {
		const input = new Input();
		if (initialValue) input.handleInput(initialValue);
		return input;
	});
		expect(rendered(component)).toContain("Live catalog unavailable: offline");
	});

	it.each([1, 10, 40, 80])("keeps each line within width %i", (width) => {
		for (const line of dialog().render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	});
});
