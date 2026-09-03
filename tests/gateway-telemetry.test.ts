import { describe, expect, it } from "vitest";
import {
	formatGatewayTokensPerSecond,
	parseOmniRouteToksHeader,
	registerGatewayTelemetry,
	tokensPerSecondFromUsage,
	wrapFetchCaptureTokensPerSecond,
} from "../src/gateway-telemetry.ts";

describe("gateway tok/s", () => {
	it("reads usage and header tok/s", () => {
		expect(tokensPerSecondFromUsage({ tokens_per_second: 80.5 })).toBe(80.5);
		expect(parseOmniRouteToksHeader(new Headers({ "X-OmniRoute-Tokens-Per-Second": "40" }))).toBe(40);
		expect(formatGatewayTokensPerSecond(40)).toBe("40.0");
	});

	it("does not invent tok/s from latency", () => {
		expect(tokensPerSecondFromUsage({ output: 200, latency_ms: 2000 })).toBeUndefined();
		expect(parseOmniRouteToksHeader(new Headers({ "X-OmniRoute-Latency-Ms": "2000", "X-OmniRoute-Tokens-Out": "200" }))).toBeUndefined();
		expect(formatGatewayTokensPerSecond(undefined)).toBe("—");
	});

	it("wrapFetchCaptureTokensPerSecond reads X-OmniRoute-Tokens-Per-Second from a Response", async () => {
		const inner: typeof fetch = async () =>
			new Response("{}", { headers: { "X-OmniRoute-Tokens-Per-Second": "40" } });
		let captured: number | undefined;
		const wrapped = wrapFetchCaptureTokensPerSecond(inner, (tps) => {
			captured = tps;
		});
		await wrapped("https://gateway.example/v1/chat/completions");
		expect(captured).toBe(40);
	});

	it("notifies tok/s from Response headers, not empty pi-ai message.usage", async () => {
		const originalFetch = globalThis.fetch;
		const handlers: Record<string, (...args: unknown[]) => void> = {};
		registerGatewayTelemetry({
			on(event, handler) {
				handlers[event] = handler;
			},
		});
		globalThis.fetch = (async () =>
			new Response("{}", { headers: { "X-OmniRoute-Tokens-Per-Second": "40" } })) as typeof fetch;
		try {
			handlers.session_start?.();
			await globalThis.fetch("https://gateway.example/v1/chat/completions");
			let notified: string | undefined;
			handlers.agent_settled?.(
				{ messages: [{ usage: { input: 10, output: 20 } }] },
				{
					hasUI: true,
					ui: {
						notify: (message: string) => {
							notified = message;
						},
					},
				},
			);
			expect(notified).toBe("tok/s 40.0");
		} finally {
			handlers.session_shutdown?.();
			globalThis.fetch = originalFetch;
		}
	});

	it("does not notify invented tok/s from latency headers", async () => {
		const originalFetch = globalThis.fetch;
		const handlers: Record<string, (...args: unknown[]) => void> = {};
		registerGatewayTelemetry({
			on(event, handler) {
				handlers[event] = handler;
			},
		});
		globalThis.fetch = (async () =>
			new Response("{}", {
				headers: { "X-OmniRoute-Latency-Ms": "2000", "X-OmniRoute-Tokens-Out": "200" },
			})) as typeof fetch;
		try {
			handlers.session_start?.();
			await globalThis.fetch("https://gateway.example/v1/chat/completions");
			let notified: string | undefined;
			handlers.agent_settled?.(
				{ messages: [{ usage: { input: 10, output: 200 } }] },
				{
					hasUI: true,
					ui: {
						notify: (message: string) => {
							notified = message;
						},
					},
				},
			);
			expect(notified).toBe("tok/s —");
		} finally {
			handlers.session_shutdown?.();
			globalThis.fetch = originalFetch;
		}
	});
});
