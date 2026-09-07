import {
	isConfigured,
	loadConfig,
	loadHopSettings,
	loadProbeConfig,
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
import { AUTO_MODELS, checkModelsEndpoint, discoverModels, isSyncStale, probeHealth, registerOmniProvider, reloadOmniProvider, setInferenceApi, testChat, transformProviderPayload } from "./provider.ts";
import { registerGatewayTelemetry } from "./gateway-telemetry.ts";
import {
	createUnreachableController,
	hopOnUnreachable,
	hopOptionsFromContext,
	isOmniActiveModel,
	isUnreachableHttpStatus,
	isUnreachableRequestFailure,
} from "./unreachable.ts";

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
	const probeConfig = loadProbeConfig(agentHome);
	const hop = loadHopSettings(agentHome);
	const result = await probeHealth(probeConfig, ctx.signal);
	ctx.ui.notify(
		[
			"OmniRoute Status",
			"",
			`Server:     ${probeConfig.serverUrl}`,
			`Provider:   ${config.providerName}`,
			`Health:     ${result.ok ? "reachable" : result.unreachable ? "unreachable" : "health check failed"}`,
			`Configured: ${isConfigured(agentHome) ? "yes" : "no — run /omni setup"}`,
			`On unreachable: ${hop.onUnreachable}${hop.fallbackModel ? ` → ${hop.fallbackModel}` : ""}`,
		].join("\n"),
		result.ok ? "info" : "warning",
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
		const storedSettings = loadSettings(agentHome);
		const settings = { ...storedSettings, ...loadHopSettings(agentHome) };
		ctx.ui.notify(
			[
				`Settings: ${settingsPath(agentHome)}`,
				`Models: ${modelsJsonPath(agentHome)}`,
				`Server: ${config.serverUrl}`,
				`Provider: ${config.providerName}`,
				`Only usable models: ${settings.onlyShowUsableModels ? "yes" : "no"}`,
				`Global routing models: ${settings.showGlobalRoutingModels ? "shown" : "hidden"}`,
				`Auto-sync interval: ${settings.autoSyncIntervalSeconds === 0 ? "off" : `${settings.autoSyncIntervalSeconds} seconds`}`,
				`On unreachable: ${settings.onUnreachable}${settings.fallbackModel ? ` → ${settings.fallbackModel}` : ""}`,
				`Gateway tok/s: ${settings.showGatewayTokensPerSecond ? "shown" : "hidden"}`,
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

	const storedSettings = loadSettings(agentHome);
	const settings: OmniSettings = { ...storedSettings, ...loadHopSettings(agentHome) };
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

	const persisted: OmniSettings = { ...saved };
	const envAction = process.env.OMNIROUTE_ON_UNREACHABLE;
	if (envAction === "none" || envAction === "host-fallback") persisted.onUnreachable = storedSettings.onUnreachable;
	if (process.env.OMNIROUTE_FALLBACK_MODEL !== undefined) persisted.fallbackModel = storedSettings.fallbackModel;
	saveConfig(agentHome, persisted, storedSettings);
	try {
		const models = await registerOmniProvider(pi, agentHome, loadConfig(agentHome), persisted, ctx.signal);
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
	let healthProbeAbortController: AbortController | undefined;
	let autoSyncTimer: ReturnType<typeof setInterval> | undefined;
	let sessionCtx: OmniContext | undefined;
	let syncInFlight: Promise<number> | null = null;
	let lastSyncCount = 0;
	const unreachable = createUnreachableController();
	let hopping = false;
	let skipNextTurnProbe = false;
	// Defer response-triggered hops until host retries have settled; the preflight probe still hops before the request.
	let pendingRequestFailure = false;

	async function maybeHop(ctx: OmniContext): Promise<void> {
		const hop = loadHopSettings(agentHome);
		const probeConfig = loadProbeConfig(agentHome);
		if (hop.onUnreachable !== "host-fallback") return;
		if (!isOmniActiveModel(ctx.model, probeConfig.providerName)) return;
		if (hopping) return;
		hopping = true;
		try {
			await hopOnUnreachable(
				{ serverUrl: probeConfig.serverUrl },
				hopOptionsFromContext(ctx, { ...hop, omniProviderName: probeConfig.providerName }, pi.setModel?.bind(pi)),
			);
		} finally {
			hopping = false;
		}
	}

	function healthStatus(result: { ok: boolean; unreachable: boolean }): string | undefined {
		if (result.ok) return undefined;
		return result.unreachable ? "OmniRoute unreachable" : "OmniRoute health check failed";
	}

	async function probeBeforeTurn(ctx: OmniContext): Promise<void> {
		const hop = loadHopSettings(agentHome);
		if (hop.onUnreachable !== "host-fallback") return;
		const probeConfig = loadProbeConfig(agentHome);
		if (!isOmniActiveModel(ctx.model, probeConfig.providerName)) return;
		const result = await unreachable.probe(probeConfig, ctx.signal, true);
		if (result.ok || !result.unreachable) return;
		if (ctx.hasUI) ctx.ui.setStatus("omni", "OmniRoute unreachable");
		await maybeHop(ctx);
	}

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
	registerGatewayTelemetry(pi, {
		providerName: () => config.providerName,
		serverUrl: () => config.serverUrl,
		showTokensPerSecond: () => loadSettings(agentHome).showGatewayTokensPerSecond,
	});

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
		const probeConfig = loadProbeConfig(agentHome);
		healthProbeAbortController?.abort();
		healthProbeAbortController = new AbortController();
		const result = await unreachable.probe(probeConfig, ctx.signal ?? healthProbeAbortController.signal);
		ctx.ui.setStatus("omni", healthStatus(result));
		if (!result.ok) {
			const message = result.unreachable
				? `OmniRoute unreachable at ${probeConfig.serverUrl}. Run /omni sync after reconnecting.`
				: `OmniRoute health check failed at ${probeConfig.serverUrl}.`;
			ctx.ui.notify(message, "warning");
		}
		if (healthTimer) clearInterval(healthTimer);
		healthTimer = setInterval(async () => {
			const next = await unreachable.probe(loadProbeConfig(agentHome), healthProbeAbortController?.signal).catch(() => undefined);
			if (next) ctx.ui.setStatus("omni", healthStatus(next));
		}, 60_000);
	});

	pi.on("before_provider_request", (event, ctx) =>
		transformProviderPayload(event.payload, ctx.model, config.providerName),
	);

	pi.on("session_shutdown", () => {
		if (healthTimer) clearInterval(healthTimer);
		healthTimer = undefined;
		healthProbeAbortController?.abort();
		healthProbeAbortController = undefined;
		stopAutoSync();
		sessionCtx = undefined;
		pendingRequestFailure = false;
		skipNextTurnProbe = false;
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		skipNextTurnProbe = true;
		await probeBeforeTurn(ctx);
	});

	pi.on("turn_start", async (_event, ctx) => {
		if (skipNextTurnProbe) {
			skipNextTurnProbe = false;
			return;
		}
		await probeBeforeTurn(ctx);
	});

	pi.on("after_provider_response", async (event, ctx) => {
		const probeConfig = loadProbeConfig(agentHome);
		if (ctx.model?.provider !== probeConfig.providerName) return;
		if (isUnreachableHttpStatus(event.status)) {
			pendingRequestFailure = true;
			unreachable.reset();
			if (ctx.hasUI) ctx.ui.setStatus("omni", "OmniRoute unreachable");
			return;
		}
		pendingRequestFailure = false;
	});

	pi.on("agent_end", (event, ctx) => {
		if (ctx.signal?.aborted) {
			pendingRequestFailure = false;
			return;
		}
		const probeConfig = loadProbeConfig(agentHome);
		const lastAssistant = [...event.messages].reverse().find((message) => message.role === "assistant");
		if (isUnreachableRequestFailure(lastAssistant, probeConfig.providerName)) {
			pendingRequestFailure = true;
			return;
		}
		if (lastAssistant?.role === "assistant" && lastAssistant.stopReason !== "error" && lastAssistant.stopReason !== "aborted") {
			pendingRequestFailure = false;
		}
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (!pendingRequestFailure) return;
		pendingRequestFailure = false;
		const probeConfig = loadProbeConfig(agentHome);
		if (ctx.model?.provider !== probeConfig.providerName) return;
		if (ctx.hasUI) ctx.ui.setStatus("omni", "OmniRoute unreachable");
		unreachable.reset();
		await maybeHop(ctx);
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
			const current = loadProbeConfig(agentHome);
			const hop = loadHopSettings(agentHome);
			const result = await unreachable.probe(current, signal);
			const configured = isConfigured(agentHome);
			return {
				content: [
					{
						type: "text",
						text: `OmniRoute ${result.ok ? "reachable" : result.unreachable ? "unreachable" : "health check failed"}; configured: ${configured}; provider: ${current.providerName}.`,
					},
				],
				details: {
					ok: result.ok,
					unreachable: result.unreachable,
					configured,
					serverUrl: current.serverUrl,
					providerName: current.providerName,
					onUnreachable: hop.onUnreachable,
					fallbackModel: hop.fallbackModel,
				},
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
