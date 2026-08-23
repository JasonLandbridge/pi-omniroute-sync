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

export interface OmniContext {
	hasUI: boolean;
	mode: "tui" | "rpc" | "json" | "print";
	signal?: AbortSignal;
	ui: OmniUI;
}

export interface ProviderModelConfig {
	id: string;
	name: string;
	api: "openai-responses";
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
}

export interface ProviderEntry {
	baseUrl: string;
	apiKey: string;
	api: "openai-responses";
	authHeader: boolean;
	compat: {
		sessionAffinityFormat: "openrouter";
		supportsLongCacheRetention: true;
	};
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
}
