import { describe, expect, it } from "vitest";
import type { OmniContext, OmniPI } from "../src/contracts.ts";
import {
	captureTokensPerSecondFromResponse,
	formatGatewayTokensPerSecond,
	isOmniRouteInferenceRequest,
	parseOmniRouteToksHeader,
	registerGatewayTelemetry,
	tokensPerSecondFromUsage,
	wrapFetchCaptureTokensPerSecond,
} from "../src/gateway-telemetry.ts";

type Handler = (...args: any[]) => any;

function fakePi(showTokensPerSecond = true): { handlers: Record<string, Handler> } {
	const handlers: Record<string, Handler> = {};
	const telemetryOptions = {
		providerName: () => "omni",
		serverUrl: () => "https://gateway.example",
		showTokensPerSecond: () => showTokensPerSecond,
	};
	registerGatewayTelemetry(
		{
			on(event: string, handler: Handler) {
				handlers[event] = handler;
			},
		} as unknown as OmniPI,
		telemetryOptions,
	);
	return { handlers };
}

function context(provider = "omni", notify?: (message: string, type?: string) => void): OmniContext {
	return {
		hasUI: true,
		mode: "tui",
		model: { provider },
		signal: undefined,
		ui: {
			input: async () => undefined,
			confirm: async () => false,
			custom: async <T>() => undefined as T,
			notify: notify ?? (() => {}),
			setStatus: () => {},
		},
	};
}

describe("gateway tok/s", () => {
	it("reads usage and header tok/s", () => {
		expect(tokensPerSecondFromUsage({ tokens_per_second: 80.5 })).toBe(80.5);
		expect(parseOmniRouteToksHeader(new Headers({ "X-OmniRoute-Tokens-Per-Second": "40" }))).toBe(40);
		expect(parseOmniRouteToksHeader({ "X-OmniRoute-Tokens-Per-Second": "41" })).toBe(41);
		expect(formatGatewayTokensPerSecond(40)).toBe("40.0");
	});

	it("does not invent tok/s from latency", () => {
		expect(tokensPerSecondFromUsage({ output: 200, latency_ms: 2000 })).toBeUndefined();
		expect(parseOmniRouteToksHeader(new Headers({ "X-OmniRoute-Latency-Ms": "2000", "X-OmniRoute-Tokens-Out": "200" }))).toBeUndefined();
		expect(formatGatewayTokensPerSecond(undefined)).toBe("—");
	});

	it("captures tok/s from the final SSE comment and usage object", async () => {
		const commentResponse = new Response(": x-omniroute-tokens-per-second=12.500\n\ndata: [DONE]\n", {
			headers: { "content-type": "text/event-stream" },
		});
		let captured: number | undefined;
		await captureTokensPerSecondFromResponse(commentResponse, (tps) => {
			captured = tps;
		});
		expect(captured).toBe(12.5);

		const usageResponse = new Response(JSON.stringify({ usage: { tokens_per_second: 80.5 } }), {
			headers: { "content-type": "application/json" },
		});
		captured = undefined;
		await captureTokensPerSecondFromResponse(usageResponse, (tps) => {
			captured = tps;
		});
		expect(captured).toBe(80.5);
	});

	it("only treats OmniRoute inference endpoints as telemetry sources", () => {
		expect(isOmniRouteInferenceRequest("https://gateway.example/v1/responses", "https://gateway.example")).toBe(true);
		expect(isOmniRouteInferenceRequest("https://gateway.example/v1/chat/completions", "https://gateway.example")).toBe(true);
		expect(isOmniRouteInferenceRequest("https://gateway.example/v1/models", "https://gateway.example")).toBe(false);
		expect(isOmniRouteInferenceRequest("https://other.example/v1/responses", "https://gateway.example")).toBe(false);
	});

	it("wraps fetch without consuming the provider response", async () => {
		const inner: typeof fetch = async () =>
			new Response("{}", { headers: { "X-OmniRoute-Tokens-Per-Second": "40" } });
		let captured: number | undefined;
		const wrapped = wrapFetchCaptureTokensPerSecond(inner, (tps) => {
			captured = tps;
		});
		const response = await wrapped("https://gateway.example/v1/chat/completions");
		expect(captured).toBe(40);
		expect(await response.text()).toBe("{}");
	});

	it("notifies from final stream telemetry on an OmniRoute agent run", async () => {
		const originalFetch = globalThis.fetch;
		const { handlers } = fakePi();
		globalThis.fetch = (async () =>
			new Response(": x-omniroute-tokens-per-second=40.000\n\n", {
				headers: { "content-type": "text/event-stream" },
			})) as typeof fetch;
		const sessionFetch = globalThis.fetch;
		let notified: string | undefined;
		const uiContext = context("omni", (message) => {
			notified = message;
		});
		try {
			handlers.session_start?.({}, uiContext);
			handlers.agent_start?.({ type: "agent_start" }, uiContext);
			const response = await globalThis.fetch("https://gateway.example/v1/chat/completions");
			await response.text();
			await handlers.agent_settled?.({ type: "agent_settled" }, uiContext);
			expect(notified).toBe("tok/s 40.0");
		} finally {
			handlers.session_shutdown?.();
			expect(globalThis.fetch).toBe(sessionFetch);
			globalThis.fetch = originalFetch;
		}
	});

	it("uses provider response headers when the host exposes them", async () => {
		const originalFetch = globalThis.fetch;
		const { handlers } = fakePi();
		let notified: string | undefined;
		const uiContext = context("omni", (message) => {
			notified = message;
		});
		try {
			handlers.session_start?.({}, uiContext);
			handlers.agent_start?.({ type: "agent_start" }, uiContext);
			handlers.after_provider_response?.(
				{ status: 200, headers: { "X-OmniRoute-Tokens-Per-Second": "40" } },
				uiContext,
			);
			await handlers.agent_settled?.({ type: "agent_settled" }, uiContext);
			expect(notified).toBe("tok/s 40.0");
		} finally {
			handlers.session_shutdown?.();
			globalThis.fetch = originalFetch;
		}
	});

	it("does not reuse an earlier response when the final response has no tok/s", async () => {
		const originalFetch = globalThis.fetch;
		const { handlers } = fakePi();
		let request = 0;
		globalThis.fetch = (async () => {
			request += 1;
			return request === 1
				? new Response("{}", { headers: { "X-OmniRoute-Tokens-Per-Second": "40" } })
				: new Response("{}", { headers: { "content-type": "application/json" } });
		}) as typeof fetch;
		let notified: string | undefined;
		const uiContext = context("omni", (message) => {
			notified = message;
		});
		try {
			handlers.session_start?.({}, uiContext);
			handlers.agent_start?.({ type: "agent_start" }, uiContext);
			await (await globalThis.fetch("https://gateway.example/v1/chat/completions")).text();
			await (await globalThis.fetch("https://gateway.example/v1/chat/completions")).text();
			await handlers.agent_settled?.({ type: "agent_settled" }, uiContext);
			expect(notified).toBe("tok/s —");
		} finally {
			handlers.session_shutdown?.();
			globalThis.fetch = originalFetch;
		}
	});

	it("does not notify when the display setting is disabled", async () => {
		const { handlers } = fakePi(false);
		let notified = false;
		const uiContext = context("omni", () => {
			notified = true;
		});
		handlers.session_start?.({}, uiContext);
		handlers.agent_start?.({ type: "agent_start" }, uiContext);
		handlers.after_provider_response?.(
			{ status: 200, headers: { "X-OmniRoute-Tokens-Per-Second": "40" } },
			uiContext,
		);
		await handlers.agent_settled?.({ type: "agent_settled" }, uiContext);
		expect(notified).toBe(false);
		handlers.session_shutdown?.();
	});

	it("uses a gateway response when Pi reports a model provider alias", async () => {
		const originalFetch = globalThis.fetch;
		const { handlers } = fakePi();
		globalThis.fetch = (async () =>
			new Response("{}", { headers: { "X-OmniRoute-Tokens-Per-Second": "40" } })) as typeof fetch;
		let notified: string | undefined;
		const uiContext = context("codex", (message) => {
			notified = message;
		});
		try {
			handlers.session_start?.({}, uiContext);
			handlers.agent_start?.({ type: "agent_start" }, uiContext);
			await (await globalThis.fetch("https://gateway.example/v1/chat/completions")).text();
			await handlers.agent_settled?.({ type: "agent_settled" }, uiContext);
			expect(notified).toBe("tok/s 40.0");
		} finally {
			handlers.session_shutdown?.();
			globalThis.fetch = originalFetch;
		}
	});

	it("does not notify for another provider or endpoint", async () => {
		const originalFetch = globalThis.fetch;
		const { handlers } = fakePi();
		globalThis.fetch = (async () =>
			new Response("{}", { headers: { "X-OmniRoute-Tokens-Per-Second": "40" } })) as typeof fetch;
		let notified = false;
		const uiContext = context("anthropic", () => {
			notified = true;
		});
		try {
			handlers.session_start?.({}, uiContext);
			handlers.agent_start?.({ type: "agent_start" }, uiContext);
			await (await globalThis.fetch("https://other.example/v1/chat/completions")).text();
			await handlers.agent_settled?.({ type: "agent_settled" }, uiContext);
			expect(notified).toBe(false);
		} finally {
			handlers.session_shutdown?.();
			globalThis.fetch = originalFetch;
		}
	});
});
