export type NotificationType = "info" | "warning" | "error";

export interface OmniComponent {
	render(width: number): readonly string[];
	handleInput?(data: string): void;
	invalidate(): void;
}

export interface OmniInput extends OmniComponent {
	onSubmit?: (value: string) => void;
	onEscape?: () => void;
	getValue(): string;
	setValue(value: string): void;
}

export interface OmniTheme {
	fg(color: "accent" | "dim" | "error" | "muted" | "success" | "text" | "warning", text: string): string;
	bold(text: string): string;
}

export interface OmniTUI {
	requestRender(): void;
}

export interface OmniUI {
	input(title: string, placeholder?: string): Promise<string | undefined>;
	confirm(title: string, message: string): Promise<boolean>;
	custom<T>(
		factory: (tui: OmniTUI, theme: OmniTheme, keybindings: unknown, done: (result: T) => void) => OmniComponent,
		options?: {
			overlay?: boolean;
			overlayOptions?: { width?: number | string; minWidth?: number; anchor?: string; margin?: number };
		},
	): Promise<T>;
	notify(message: string, type?: NotificationType): void;
	setStatus(key: string, text: string | undefined): void;
}

export interface OmniRequestModel {
	provider?: string;
	omitMaxOutputTokens?: boolean;
	supportsTools?: boolean;
}

export interface ProviderRequestEvent {
	payload: unknown;
}

export interface OmniContext {
	hasUI: boolean;
	mode: "tui" | "rpc" | "json" | "print";
	model?: OmniRequestModel;
	signal?: AbortSignal;
	ui: OmniUI;
}

export type ProviderApi = "openai-completions" | "openai-responses";
export type ProviderThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ProviderThinkingLevelMap = Partial<Record<ProviderThinkingLevel, string | null>>;

export interface OmniThinking {
	mode: "effort";
	efforts: string[];
}

export interface ProviderCompat {
	sessionAffinityFormat?: "openrouter" | "openai";
	promptCacheSessionHeader?: string;
	supportsLongCacheRetention?: boolean;
	supportsMaxOutputTokens?: boolean;
}

export interface ProviderModelConfig {
	id: string;
	name: string;
	api: ProviderApi;
	reasoning: boolean;
	input: string[];
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		tiers: Array<{
			input: number;
			output: number;
			cacheRead: number;
			cacheWrite: number;
			inputTokensAbove: number;
		}>;
	};
	contextWindow: number;
	maxTokens: number;
	omitMaxOutputTokens?: boolean;
	supportsTools?: boolean;
	thinkingLevelMap?: ProviderThinkingLevelMap;
	thinking?: OmniThinking;
	compat?: ProviderCompat;
}

export interface ProviderEntry {
	baseUrl: string;
	apiKey: string;
	api: ProviderApi;
	auth?: "apiKey" | "none" | "oauth";
	authHeader: boolean;
	compat: ProviderCompat;
	models: ProviderModelConfig[];
}

interface ToolResult<TDetails> {
	content: Array<{ type: "text"; text: string }>;
	details: TDetails;
}

export interface OmniPI {
	registerProvider(name: string, config: ProviderEntry): void;
	registerTool<TDetails>(tool: {
		name: string;
		label: string;
		description: string;
		parameters: { type: "object"; properties: Record<string, never> };
		execute(id: string, params: Record<string, never>, signal?: AbortSignal): Promise<ToolResult<TDetails>>;
	}): void;
	registerCommand(
		name: string,
		opts: {
			description: string;
			getArgumentCompletions?(prefix: string): { value: string; label: string }[];
			handler(args: string, ctx: OmniContext): Promise<void>;
		},
	): void;
	on(event: "session_start", handler: (event: unknown, ctx: OmniContext) => void | Promise<void>): void;
	on(event: "before_provider_request", handler: (event: ProviderRequestEvent, ctx: OmniContext) => unknown | Promise<unknown>): void;
	on(event: "session_shutdown", handler: () => void): void;
	on(
		event: "model_select",
		handler: (event: { model?: { id?: string } }, ctx: OmniContext) => void | Promise<void>,
	): void;
}

export interface AgentHomeOptions {
	homeEnvVar: string;
	defaultHome: string;
	matchesKey(data: string, key: string): boolean;
	createInput(initialValue: string): OmniInput;
	/** Wire API for OmniRoute. OMP uses chat completions; Pi defaults to Responses. */
	inferenceApi?: ProviderApi;
}
