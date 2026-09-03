import { describe, expect, it } from "vitest";
import {
	formatGatewayTokensPerSecond,
	parseOmniRouteToksHeader,
	tokensPerSecondFromUsage,
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
});
