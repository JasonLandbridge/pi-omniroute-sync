import {
	isConfigured,
	loadConfig,
	loadSettings,
	modelsJsonPath,
	resolveAgentHome,
	sanitizeConfig,
	saveConfig,
	saveSettings,
	settingsPath,
	type OmniConfig,
	type OmniSettings,
} from "./config.ts";
import { ConfigDialog, summarizeModels, type ModelSummary } from "./config-dialog.ts";
import type { AgentHomeOptions, OmniContext, OmniPI, ProviderModelConfig } from "./contracts.ts";
import { AUTO_MODELS, checkHealth, checkModelsEndpoint, discoverModels, isSyncStale, registerOmniProvider, reloadOmniProvider, setInferenceApi, testChat, transformProviderPayload } from "./provider.ts";

function sortKey(id: string): string {
	const autoIndex = AUTO_MODELS.indexOf(id);
	return autoIndex >= 0 ? `0:${String(autoIndex).padStart(3, "0")}` : `1:${id}`;
}

function modelLines(models: ProviderModelConfig[], query = "", limit = 80): string[] {
	const normalizedQuery = query.toLowerCase();
	const filtered = normalizedQuery
		? models.filter((model) => `${model.id} ${model.name}`.toLowerCase().includes(normalizedQuery))
		: models;
	const sorted = [...filtered].sort((a, b) => sortKey(a.id).localeCompare(sortKey(b.id)) || a.id.localeCompare(b.id));
	const groups = new Map<string, ProviderModelConfig[]>();
	for (const model of sorted) {
		const group = AUTO_MODELS.includes(model.id) ? "auto" : model.id.includes("/") ? model.id.split("/")[0] : "direct";
		groups.set(group, [...(groups.get(group) ?? []), model]);
	}
	const entries = [...groups].sort(([a], [b]) => (a === "auto" ? -1 : b === "auto" ? 1 : a.localeCompare(b)));
	const lines: string[] = [];

	for (const [group, groupModels] of entries) {
		lines.push(`-- ${group} (${groupModels.length}) --`);
		for (const model of groupModels) {
			const tags = [model.reasoning ? "reasoning" : "", model.input.includes("image") ? "vision" : ""]
				.filter(Boolean)
				.join(", ");
			lines.push(`  ${model.id} | ${model.contextWindow} ctx | ${model.maxTokens} out${tags ? ` | ${tags}` : ""}`);
			if (lines.length >= limit) break;
		}
		if (lines.length >= limit) break;
	}
	if (!filtered.length) lines.push("No models matched.");
	else if (filtered.length > limit) lines.push(`... ${filtered.length} total; refine with /omni models <search>`);
	return lines;
}

async function showStatus(ctx: OmniContext, agentHome: string, config: OmniConfig): Promise<void> {
	const ok = await checkHealth(config, ctx.signal);
	ctx.ui.notify(
		[
			"OmniRoute Status",
			"",
			`Server:     ${config.serverUrl}`,
			`Provider:   ${config.providerName}`,
			`Health:     ${ok ? "reachable" : "unreachable"}`,
			`Configured: ${isConfigured(agentHome) ? "yes" : "no — run /omni setup"}`,
		].join("\n"),
		ok ? "info" : "warning",
	);
}

function helpText(): string {
	return [
		"OmniRoute commands",
		"",
		"/omni                  Status",
		"/omni setup            Configure server URL and API key",
		"/omni sync             Sync models to Ctrl+P / /model picker",
		"/omni models [search]  Browse models",
		"/omni test <model>     Smoke-test the configured OmniRoute inference API",
		"/omni dashboard        Show OmniRoute dashboard URL",
		"/omni config           Show config paths and current settings",
		"/omni autosync [status|on|off|<seconds>]  Background catalog refresh while running",
		"/omni help             Show this help",
	].join("\n");
}

async function showConfigDialog(
	ctx: OmniContext,
	pi: OmniPI,
	agentHome: string,
	options: AgentHomeOptions,
): Promise<void> {
	if (ctx.mode !== "tui") {
		const config = loadConfig(agentHome);
		const settings = loadSettings(agentHome);
		ctx.ui.notify(
			[
				`Settings: ${settingsPath(agentHome)}`,
				`Models: ${modelsJsonPath(agentHome)}`,
				`Server: ${config.serverUrl}`,
				`Provider: ${config.providerName}`,
				`Only usable models: ${settings.onlyShowUsableModels ? "yes" : "no"}`,
				`Global routing models: ${settings.showGlobalRoutingModels ? "shown" : "hidden"}`,
				`Auto-sync interval: ${settings.autoSyncIntervalSeconds === 0 ? "off" : `${settings.autoSyncIntervalSeconds} seconds`}`,
				`API key: ${config.apiKey ? "configured" : "not configured"}`,
			].join("\n"),
			"info",
		);
		return;
	}

	let summary: ModelSummary | undefined;
	let summaryError: string | undefined;
	const refreshSummary = async () => {
		try {
			const settings = loadSettings(agentHome);
			summary = summarizeModels(await discoverModels(loadConfig(agentHome), settings, ctx.signal));
			summaryError = undefined;
		} catch (error) {
			summary = undefined;
			summaryError = (error as Error).message;
		}
	};
	await refreshSummary();

	const settings = loadSettings(agentHome);
	const saved = await ctx.ui.custom<OmniSettings | undefined>((tui, theme, _keybindings, done) => {
		const sync = async () => {
			try {
				const models = await registerOmniProvider(pi, agentHome, loadConfig(agentHome), loadSettings(agentHome), ctx.signal);
				return { summary: summarizeModels(models) };
			} catch (error) {
				return { error: (error as Error).message };
			} finally {
				tui.requestRender();
			}
		};
		const dialog = new ConfigDialog(settings, summary, summaryError, theme, done, options.matchesKey, sync, options.createInput);
		return {
			render: (width) => dialog.render(width),
			invalidate: () => dialog.invalidate(),
			handleInput: (data) => {
				dialog.handleInput(data);
				tui.requestRender();
			},
		};
	}, {
		overlay: true,
		overlayOptions: { width: "80%", minWidth: 60, anchor: "center", margin: 2 },
	});
	if (!saved) return;

	saveConfig(agentHome, saved, saved);
	try {
		const models = await registerOmniProvider(pi, agentHome, loadConfig(agentHome), saved, ctx.signal);
		ctx.ui.notify(`Settings saved; OmniRoute synced ${models.length} model(s).`, "info");
	} catch (error) {
		ctx.ui.notify(`Settings saved, but sync failed: ${(error as Error).message}`, "error");
	}
}

async function runSetup(ctx: OmniContext, pi: OmniPI, agentHome: string): Promise<OmniConfig | undefined> {
	const storedSettings = loadSettings(agentHome);
	const current = loadConfig(agentHome);
	const serverUrl = await ctx.ui.input("OmniRoute server URL", current.serverUrl);
	if (serverUrl === undefined) return undefined;
	const apiKey = await ctx.ui.input(
		"OmniRoute API key",
		current.apiKey ? "(press enter to keep current)" : "(optional — press enter to skip)",
	);
	if (apiKey === undefined) return undefined;

	const next = sanitizeConfig({ ...current, serverUrl, apiKey: apiKey || storedSettings.apiKey });
	const runtimeConfig = { ...next, apiKey: process.env.OMNIROUTE_API_KEY ?? next.apiKey };
	if (!(await checkModelsEndpoint(runtimeConfig, ctx.signal))) {
		ctx.ui.notify(`Cannot reach ${next.serverUrl}/v1/models.`, "error");
		return undefined;
	}

	saveConfig(agentHome, next, storedSettings);
	const models = await registerOmniProvider(pi, agentHome, runtimeConfig, loadSettings(agentHome), ctx.signal);
	ctx.ui.notify(`Saved. Synced ${models.length} model(s).`, "info");
	return next;
}

export async function createOmniExtension(pi: OmniPI, options: AgentHomeOptions): Promise<void> {
	setInferenceApi(options.inferenceApi);
	const agentHome = resolveAgentHome(options);
	let config = loadConfig(agentHome);
	let healthTimer: ReturnType<typeof setInterval> | undefined;
	let autoSyncTimer: ReturnType<typeof setInterval> | undefined;
	let sessionCtx: OmniContext | undefined;
	let syncInFlight: Promise<number> | null = null;
	let lastSyncCount = 0;

	async function sync(ctx?: OmniContext, options?: { quiet?: boolean }): Promise<number> {
		if (syncInFlight) return syncInFlight;
		const quiet = options?.quiet === true;
		syncInFlight = (async () => {
			config = loadConfig(agentHome);
			const models = await registerOmniProvider(pi, agentHome, config, loadSettings(agentHome), ctx?.signal);
			const previous = lastSyncCount;
			lastSyncCount = models.length;
			const notifyCtx = ctx ?? sessionCtx;
			if (!quiet) notifyCtx?.ui.notify(`OmniRoute synced ${models.length} model(s).`, "info");
			else if (previous > 0 && previous !== models.length) {
				notifyCtx?.ui.notify(`OmniRoute auto-sync: catalog ${previous} → ${models.length} model(s).`, "info");
			}
			return models.length;
		})().finally(() => {
			syncInFlight = null;
		});
		return syncInFlight;
	}

	function stopAutoSync(): void {
		if (autoSyncTimer) clearInterval(autoSyncTimer);
		autoSyncTimer = undefined;
	}

	function startAutoSync(ctx: OmniContext): void {
		stopAutoSync();
		sessionCtx = ctx;
		const intervalSeconds = loadSettings(agentHome).autoSyncIntervalSeconds;
		if (intervalSeconds === 0) return;
		autoSyncTimer = setInterval(() => {
			void sync(undefined, { quiet: true }).catch((error) => {
				sessionCtx?.ui.notify(`OmniRoute auto-sync failed: ${(error as Error).message}`, "warning");
			});
		}, intervalSeconds * 1000);
	}

	reloadOmniProvider(pi, agentHome, config);

	pi.on("session_start", async (_event, ctx) => {
		sessionCtx = ctx;
		config = loadConfig(agentHome);
		const settings = loadSettings(agentHome);
		if (settings.syncOnStartup && isConfigured(agentHome) && isSyncStale(settings)) {
			try {
				lastSyncCount = (await registerOmniProvider(pi, agentHome, config, settings, ctx.signal)).length;
			} catch (error) {
				if (ctx.hasUI) ctx.ui.notify(`OmniRoute startup sync failed; using previous models: ${(error as Error).message}`, "warning");
			}
		}
		if (!isConfigured(agentHome) && !process.env.OMNIROUTE_URL) {
			if (ctx.hasUI) {
				ctx.ui.setStatus("omni", "OmniRoute unconfigured");
				ctx.ui.notify("OmniRoute loaded. Run /omni setup to connect.", "warning");
			}
			return;
		}
		startAutoSync(ctx);
		if (!ctx.hasUI) return;
		const ok = await checkHealth(config);
		ctx.ui.setStatus("omni", ok ? undefined : "OmniRoute unreachable");
		if (!ok) ctx.ui.notify(`OmniRoute unreachable at ${config.serverUrl}. Run /omni sync after reconnecting.`, "warning");
		if (healthTimer) clearInterval(healthTimer);
		healthTimer = setInterval(async () => {
			ctx.ui.setStatus("omni", (await checkHealth(loadConfig(agentHome))) ? undefined : "OmniRoute unreachable");
		}, 60_000);
	});

	pi.on("before_provider_request", (event, ctx) =>
		transformProviderPayload(event.payload, ctx.model, config.providerName),
	);

	pi.on("session_shutdown", () => {
		if (healthTimer) clearInterval(healthTimer);
		healthTimer = undefined;
		stopAutoSync();
		sessionCtx = undefined;
	});

	pi.on("model_select", (event, ctx) => {
		if (ctx.hasUI && event.model?.id) ctx.ui.setStatus("omni", `→ ${event.model.id}`);
	});

	pi.registerTool({
		name: "omniroute_status",
		label: "OmniRoute Status",
		description: "Return OmniRoute health and provider registration status.",
		parameters: { type: "object", properties: {} },
		async execute(_id, _params, signal) {
			const current = loadConfig(agentHome);
			const ok = await checkHealth(current, signal);
			const configured = isConfigured(agentHome);
			return {
				content: [
					{
						type: "text",
						text: `OmniRoute ${ok ? "reachable" : "unreachable"}; configured: ${configured}; provider: ${current.providerName}.`,
					},
				],
				details: { ok, configured, serverUrl: current.serverUrl, providerName: current.providerName },
			};
		},
	});

	pi.registerTool({
		name: "omniroute_sync",
		label: "OmniRoute Sync",
		description: "Fetch /v1/models from OmniRoute and register them as a provider.",
		parameters: { type: "object", properties: {} },
		async execute(_id, _params, signal) {
			const current = loadConfig(agentHome);
			const models = await registerOmniProvider(pi, agentHome, current, loadSettings(agentHome), signal);
			return {
				content: [{ type: "text", text: `OmniRoute synced ${models.length} model(s).` }],
				details: { count: models.length, provider: current.providerName },
			};
		},
	});

	pi.registerCommand("omni", {
		description: "OmniRoute: /omni [setup|sync|models|test|dashboard|config|autosync|help]",
		getArgumentCompletions(prefix) {
			return ["setup", "sync", "models", "test", "dashboard", "config", "autosync", "help"]
				.filter((value) => value.startsWith(prefix))
				.map((value) => ({ value, label: value }));
		},
		async handler(args, ctx) {
			if (!ctx.hasUI) return;
			const [subcommand = "", ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const sub = subcommand.toLowerCase();
			config = loadConfig(agentHome);

			try {
				if (!sub) return showStatus(ctx, agentHome, config);
				if (sub === "help") return ctx.ui.notify(helpText(), "info");
				if (sub === "setup") {
					const next = await runSetup(ctx, pi, agentHome);
					if (next) {
						config = next;
						startAutoSync(ctx);
					}
					return;
				}
				if (sub === "sync") return void (await sync(ctx));
				if (sub === "models") {
					const models = await discoverModels(config, loadSettings(agentHome), ctx.signal).catch((error) => {
						if (ctx.signal?.aborted) throw error;
						return [];
					});
					return ctx.ui.notify(
						[`OmniRoute models (${models.length})`, "", ...modelLines(models, rest.join(" "))].join("\n"),
						"info",
					);
				}
				if (sub === "test") {
					const model = rest.join(" ");
					if (!model) return ctx.ui.notify("Usage: /omni test <model>", "warning");
					return ctx.ui.notify(`Test ${model}: ${await testChat(config, model, ctx.signal)}`, "info");
				}
				if (sub === "dashboard" || sub === "dash") {
					return ctx.ui.notify(`OmniRoute dashboard: ${config.serverUrl}`, "info");
				}
				if (sub === "config") {
					await showConfigDialog(ctx, pi, agentHome, options);
					startAutoSync(ctx);
					return;
				}
				if (sub === "autosync") {
					const arg = (rest[0] || "status").toLowerCase();
					const settings = loadSettings(agentHome);
					if (arg === "status" || arg === "") {
						const intervalSeconds = settings.autoSyncIntervalSeconds;
						return ctx.ui.notify(
							`Auto-sync: ${intervalSeconds === 0 ? "off" : `every ${intervalSeconds}s`}\nActive: ${autoSyncTimer ? "yes" : "no (starts with session)"}`,
							"info",
						);
					}
					let seconds: number | undefined;
					if (arg === "off" || arg === "disable" || arg === "0") seconds = 0;
					else if (arg === "on" || arg === "enable" || arg === "default") seconds = 300;
					else if (/^\d+$/.test(arg)) {
						const value = Number(arg);
						if (Number.isSafeInteger(value)) seconds = value;
					}
					if (seconds === undefined) return ctx.ui.notify("Usage: /omni autosync [status|on|off|<seconds>]", "warning");
					saveSettings(agentHome, { ...settings, autoSyncIntervalSeconds: Math.floor(seconds) });
					startAutoSync(ctx);
					return ctx.ui.notify(`OmniRoute auto-sync ${seconds === 0 ? "disabled" : `set to every ${seconds}s`}.`, "info");
				}
				ctx.ui.notify(`Unknown /omni command '${sub}'.\n\n${helpText()}`, "warning");
			} catch (error) {
				ctx.ui.notify(`OmniRoute error: ${(error as Error).message}`, "error");
			}
		},
	});
}
