import type { OmniSettings } from "./config.ts";
import type { OmniComponent, OmniInput, OmniTheme, ProviderModelConfig } from "./contracts.ts";
import { AUTO_MODELS } from "./provider.ts";

export type KeyMatcher = (data: string, key: string) => boolean;
export type ConfigDialogTab = "summary" | "config";
type EditingField = "serverUrl" | "includeModels" | "excludeModels" | "modelCacheTtlMinutes" | "autoSyncIntervalSeconds" | "fallbackModel" | "apiKey";

export interface ModelSummary {
	total: number;
	auto: number;
	providerGroups: number;
	reasoning: number;
	vision: number;
	minContext: number;
	maxContext: number;
}

export interface SyncResult {
	summary?: ModelSummary;
	error?: string;
}

export function summarizeModels(models: ProviderModelConfig[]): ModelSummary {
	const contexts = models.map((model) => model.contextWindow).filter((value) => value > 0);
	return {
		total: models.length,
		auto: models.filter((model) => AUTO_MODELS.includes(model.id)).length,
		providerGroups: new Set(models.filter((model) => !AUTO_MODELS.includes(model.id)).map((model) => model.id.split("/")[0])).size,
		reasoning: models.filter((model) => model.reasoning).length,
		vision: models.filter((model) => model.input.includes("image")).length,
		minContext: contexts.length ? Math.min(...contexts) : 0,
		maxContext: contexts.length ? Math.max(...contexts) : 0,
	};
}

function visibleWidth(value: string): number {
	return value.replace(/\u001b\[[0-9;]*m/g, "").length;
}

function clip(value: string, width: number): string {
	let visible = 0;
	let result = "";
	for (let index = 0; index < value.length && visible < width; ) {
		const ansi = value.slice(index).match(/^\u001b\[[0-9;]*m/);
		if (ansi) {
			result += ansi[0];
			index += ansi[0].length;
			continue;
		}
		result += value[index++];
		visible++;
	}
	return result;
}

function pad(value: string, width: number): string {
	const clipped = clip(value, width);
	return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}

function frameLine(value: string, width: number): string {
	return `│${pad(value, Math.max(1, width - 2))}│`;
}

function validServerUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}

export class ConfigDialog implements OmniComponent {
	private tab: ConfigDialogTab = "summary";
	private selected = 0;
	private status = "Live catalog loaded without changing synced models.";
	private summary: ModelSummary | undefined;
	private summaryError: string | undefined;
	private editing: EditingField | undefined;
	private input: OmniInput | undefined;
	private readonly draft: OmniSettings;
	private readonly theme: OmniTheme;
	private readonly done: (settings: OmniSettings | undefined) => void;
	private readonly matchesKey: KeyMatcher;
	private readonly onSync?: () => Promise<SyncResult>;
	private readonly createInput: (initialValue: string) => OmniInput;

	constructor(
		settings: OmniSettings,
		summary: ModelSummary | undefined,
		summaryError: string | undefined,
		theme: OmniTheme,
		done: (settings: OmniSettings | undefined) => void,
		matchesKey: KeyMatcher,
		onSync: (() => Promise<SyncResult>) | undefined,
		createInput: (initialValue: string) => OmniInput,
	) {
		this.draft = { ...settings };
		this.summary = summary;
		this.summaryError = summaryError;
		this.theme = theme;
		this.done = done;
		this.matchesKey = matchesKey;
		this.onSync = onSync;
		this.createInput = createInput;
		if (summaryError) this.status = `Live catalog unavailable: ${summaryError}`;
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (this.editing) return this.handleEditorInput(data);
		if (this.matchesKey(data, "ctrl+c")) return this.done(undefined);
		if (this.matchesKey(data, "escape")) return this.done({ ...this.draft });
		if (this.matchesKey(data, "space")) {
			if (this.tab === "config" && [2, 3, 6, 9, 11].includes(this.selected)) this.toggleSelectedBoolean();
			return;
		}
		if (this.matchesKey(data, "left") || this.matchesKey(data, "shift+tab") || this.matchesKey(data, "[")) return this.switchTab("summary");
		if (this.matchesKey(data, "right") || this.matchesKey(data, "tab") || this.matchesKey(data, "]")) return this.switchTab("config");
		if (this.matchesKey(data, "up") || this.matchesKey(data, "k")) return this.move(-1);
		if (this.matchesKey(data, "down") || this.matchesKey(data, "j")) return this.move(1);
		if (this.matchesKey(data, "s") && this.tab === "summary") return this.sync();
		if (this.matchesKey(data, "enter")) this.activate();
	}

	render(width: number): string[] {
		if (width < 3) return [clip(this.theme.bold("OmniRoute"), Math.max(0, width))];
		const inner = width - 2;
		const border = "─".repeat(inner);
		const tab = (id: ConfigDialogTab, label: string) =>
			this.tab === id ? this.theme.fg("accent", this.theme.bold(`[ ${label} ]`)) : this.theme.fg("muted", `  ${label}  `);
		const body = this.editing ? this.editorLines() : this.tab === "summary" ? this.summaryLines() : this.configLines();
		return [
			`┌${border}┐`,
			frameLine(` ${this.theme.fg("accent", this.theme.bold("OmniRoute"))}  Configuration`, width),
			frameLine(` ${tab("summary", "Summary")} ${tab("config", "Config")}`, width),
			`├${border}┤`,
			...body.map((line) => frameLine(` ${line}`, width)),
			`├${border}┤`,
			frameLine(` ${this.theme.fg(this.summaryError ? "error" : "dim", this.status)}`, width),
			frameLine(` ${this.theme.fg("dim", this.footerHelp())}`, width),
			`└${border}┘`,
		];
	}

	private handleEditorInput(data: string): void {
		if (this.matchesKey(data, "ctrl+c")) {
			this.cancelEditor();
			return;
		}
		this.input?.handleInput?.(data);
	}

	private commitEditor(value: string): void {
		if (this.editing === "serverUrl" && !validServerUrl(value)) {
			this.status = "Invalid server URL. Use an http:// or https:// URL.";
			return;
		}
		if (this.editing === "includeModels" || this.editing === "excludeModels") {
			this.draft[this.editing] = value.split(",").map((pattern) => pattern.trim()).filter(Boolean);
		} else if (this.editing === "modelCacheTtlMinutes") {
			const ttl = Number(value);
			if (!Number.isFinite(ttl) || ttl < 0) {
				this.status = "Cache TTL must be a non-negative number of minutes.";
				return;
			}
			this.draft.modelCacheTtlMinutes = ttl;
		} else if (this.editing === "autoSyncIntervalSeconds") {
			const interval = Number(value.trim());
			if (!value.trim() || !Number.isFinite(interval) || interval < 0) {
				this.status = "Auto-sync interval must be a non-negative number of seconds.";
				return;
			}
			this.draft.autoSyncIntervalSeconds = Math.floor(interval);
		} else if (this.editing === "fallbackModel") {
			this.draft.fallbackModel = value.trim();
		} else {
			this.draft[this.editing as "serverUrl" | "apiKey"] = value;
		}
		this.status = "Setting updated in draft. Escape saves and closes.";
		this.editing = undefined;
		this.input = undefined;
	}

	private cancelEditor(): void {
		this.editing = undefined;
		this.input = undefined;
		this.status = "Edit cancelled. Draft settings are unchanged.";
	}

	private switchTab(tab: ConfigDialogTab): void {
		this.tab = tab;
		this.selected = 0;
		this.status = tab === "summary" ? "Live catalog loaded without changing synced models." : "Edit freely; Escape saves all changes and closes.";
	}

	private move(delta: number): void {
		this.selected = Math.max(0, Math.min((this.tab === "summary" ? 1 : 14) - 1, this.selected + delta));
		this.status = this.rowDescription();
	}

	private activate(): void {
		if (this.tab === "summary") return this.sync();
		if (this.selected === 0) return this.startEditing("serverUrl", this.draft.serverUrl);
		if ([2, 3, 6, 9, 11].includes(this.selected)) return this.toggleSelectedBoolean();
		if (this.selected === 4) return this.startEditing("includeModels", this.draft.includeModels.join(", "));
		if (this.selected === 5) return this.startEditing("excludeModels", this.draft.excludeModels.join(", "));
		if (this.selected === 7) return this.startEditing("modelCacheTtlMinutes", String(this.draft.modelCacheTtlMinutes));
		if (this.selected === 8) return this.startEditing("autoSyncIntervalSeconds", String(this.draft.autoSyncIntervalSeconds));
		if (this.selected === 10) return this.startEditing("fallbackModel", this.draft.fallbackModel);
		if (this.selected === 12) return this.startEditing("apiKey", "");
		if (this.selected === 13) {
			this.draft.apiKey = "";
			this.status = "API key cleared in draft. Escape saves and closes.";
		}
	}

	private startEditing(field: EditingField, value: string): void {
		this.editing = field;
		this.input = this.createInput(value);
		this.input.onSubmit = (submitted) => this.commitEditor(submitted);
		this.input.onEscape = () => this.cancelEditor();
		this.status = "Enter commits this field · Escape cancels this field edit.";
	}

	private toggleSelectedBoolean(): void {
		if (this.selected === 2) {
			this.draft.onlyShowUsableModels = !this.draft.onlyShowUsableModels;
			this.status = `Model visibility set to ${this.draft.onlyShowUsableModels ? "usable models only" : "full catalog"} in draft. Escape saves and closes.`;
			return;
		}
		if (this.selected === 3) {
			this.draft.showGlobalRoutingModels = !this.draft.showGlobalRoutingModels;
			this.status = `Global routing models ${this.draft.showGlobalRoutingModels ? "shown" : "hidden"} in draft. Escape saves and closes.`;
			return;
		}
		if (this.selected === 6) {
			this.draft.syncOnStartup = !this.draft.syncOnStartup;
			this.status = `Stale startup sync ${this.draft.syncOnStartup ? "enabled" : "disabled"} in draft. Escape saves and closes.`;
			return;
		}
		if (this.selected === 9) {
			this.draft.onUnreachable = this.draft.onUnreachable === "host-fallback" ? "none" : "host-fallback";
			this.status = `Unreachable behavior set to ${this.draft.onUnreachable} in draft. Escape saves and closes.`;
			return;
		}
		this.draft.showGatewayTokensPerSecond = !this.draft.showGatewayTokensPerSecond;
		this.status = `Gateway tok/s display ${this.draft.showGatewayTokensPerSecond ? "enabled" : "disabled"} in draft. Escape saves and closes.`;
	}

	private sync(): void {
		if (!this.onSync) return;
		this.status = "Syncing models…";
		void this.onSync().then((result) => {
			this.summary = result.summary ?? this.summary;
			this.summaryError = result.error;
			this.status = result.error ? `Sync failed: ${result.error}` : "Models synced successfully.";
		});
	}

	private row(index: number, label: string, value: string, control = false): string {
		const selected = this.selected === index;
		const cursor = selected ? this.theme.fg("accent", "›") : " ";
		return `${cursor} ${this.theme.fg(selected ? "text" : "muted", label)}  ${control ? this.toggleValue(value === "on") : value}`;
	}

	private toggleValue(enabled: boolean): string {
		const on = enabled ? this.theme.fg("success", this.theme.bold("● ON")) : this.theme.fg("dim", "○ ON");
		const off = enabled ? this.theme.fg("dim", "○ OFF") : this.theme.fg("warning", this.theme.bold("● OFF"));
		return `${on}  ${off}`;
	}

	private summaryLines(): string[] {
		if (!this.summary) return [this.theme.fg("error", `Live catalog unavailable: ${this.summaryError ?? "unknown error"}`), "", this.row(0, "Sync models", "Enter or s")];
		return [
			this.theme.bold("Live OmniRoute catalog"),
			`Models             ${this.summary.total}`,
			`Provider groups    ${this.summary.providerGroups}`,
			`Auto models        ${this.summary.auto}`,
			`Reasoning          ${this.summary.reasoning}`,
			`Vision             ${this.summary.vision}`,
			`Context range      ${this.summary.minContext.toLocaleString()}–${this.summary.maxContext.toLocaleString()} tokens`,
			`Active filter      ${this.draft.onlyShowUsableModels ? "usable models only" : "full catalog"}`,
			`Global routing     ${this.draft.showGlobalRoutingModels ? "shown" : "hidden"}`,
			"",
			this.row(0, "Sync models", "Enter or s"),
		];
	}

	private configLines(): string[] {
		return [
			this.theme.bold("Connection"),
			this.row(0, "Server URL", this.draft.serverUrl),
			this.row(1, "Provider name", `${this.draft.providerName}  ${this.theme.fg("dim", "read-only")}`),
			"",
			this.theme.bold("Model visibility"),
			this.row(2, "Only show usable models", this.draft.onlyShowUsableModels ? "on" : "off", true),
			this.row(3, "Show global routing models", this.draft.showGlobalRoutingModels ? "on" : "off", true),
			this.row(4, "Include model globs", this.draft.includeModels.join(", ") || "all"),
			this.row(5, "Exclude model globs", this.draft.excludeModels.join(", ") || "none"),
			"",
			this.theme.bold("Startup sync"),
			this.row(6, "Sync stale models on startup", this.draft.syncOnStartup ? "on" : "off", true),
			this.row(7, "Model cache TTL", `${this.draft.modelCacheTtlMinutes} minutes`),
			this.row(8, "Auto-sync interval", this.draft.autoSyncIntervalSeconds === 0 ? "off" : `${this.draft.autoSyncIntervalSeconds} seconds`),
			"",
			this.theme.bold("Unreachable fallback"),
			this.row(9, "On unreachable", this.draft.onUnreachable),
			this.row(10, "Fallback model", this.draft.fallbackModel || "notify only"),
			"",
			this.theme.bold("Gateway telemetry"),
			this.row(11, "Show gateway tok/s", this.draft.showGatewayTokensPerSecond ? "on" : "off", true),
			"",
			this.theme.bold("Credentials"),
			this.row(12, "API key", this.draft.apiKey ? "configured — replace" : "not configured — set"),
			this.row(13, "Clear API key", this.draft.apiKey ? "available" : "already empty"),
		];
	}

	private editorLines(): string[] {
		const masked = this.editing === "apiKey";
		const inputLine = masked ? `> ${"•".repeat(this.input?.getValue().length ?? 0)}` : (this.input?.render(70)[0] ?? ">");
		return [
			this.theme.bold(masked ? "Replace API key" : `Edit ${this.editing}`),
			"",
			inputLine,
			"",
			this.theme.fg("dim", "Enter commits this field · Escape cancels this field edit"),
		];
	}

	private rowDescription(): string {
		if (this.tab === "summary") return "Sync updates the persisted provider and model picker.";
		return [
			"Edit the server URL inline.",
			"Provider name is read-only to avoid duplicate runtime providers.",
			"Space or Enter switches between usable models and the full catalog.",
			"Space or Enter shows or hides synthetic global routing models.",
			"Comma-separated globs; non-matching models are hidden.",
			"Comma-separated globs applied after include filters.",
			"Sync once on startup when the cache is stale.",
			"Minutes before startup considers the model cache stale; zero means always.",
			"Seconds between background catalog refreshes; zero disables autosync.",
			"Space or Enter switches between status-only and host-fallback behavior.",
			"Host provider/id to select when OmniRoute is unreachable; empty means notify only.",
			"Show or hide gateway-reported tok/s after OmniRoute turns.",
			"Replace the API key in a masked inline editor.",
			"Clear the API key in the draft.",
		][this.selected] ?? "";
	}

	private footerHelp(): string {
		if (this.editing) return "type to edit · enter commit field · esc cancel field · ctrl+c cancel all";
		if (this.tab === "summary") return "←/→ tabs · ↑/↓ move · enter/s sync · esc save & close · ctrl+c cancel";
		return [2, 3, 6, 9, 11].includes(this.selected)
			? "↑/↓ move · space/enter toggle draft · esc save & close · ctrl+c cancel"
			: "↑/↓ move · enter edit · esc save & close · ctrl+c cancel";
	}
}
