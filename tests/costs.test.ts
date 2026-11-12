import { afterEach, expect, it, vi } from "vitest";
import { formatCost, formatTokens, formatCostsReport, loadCostsReport, parseProviderQuota, parseCostsSummary, type CostsReport } from "../src/costs.ts";

const fetchStub = vi.spyOn(globalThis, "fetch");
const config = { serverUrl: "http://localhost:20128", apiKey: "secret", providerName: "omni" };

afterEach(() => fetchStub.mockReset());

it("parses analytics totals from the summary block", () => {
	expect(
		parseCostsSummary({
			summary: {
				totalRequests: 45,
				successRatePct: 100,
				avgLatencyMs: 4315,
				promptTokens: 3990421,
				completionTokens: 15267,
				totalTokens: 4005688,
				totalCost: 0.268815,
				fallbackCount: 2,
			},
		}),
	).toEqual({
		requestCount: 45,
		successRatePct: 100,
		avgLatencyMs: 4315,
		promptTokens: 3990421,
		completionTokens: 15267,
		totalTokens: 4005688,
		totalCost: 0.268815,
		fallbackCount: 2,
	});
	expect(parseCostsSummary({})).toEqual({
		requestCount: 0,
		successRatePct: 0,
		avgLatencyMs: 0,
		promptTokens: 0,
		completionTokens: 0,
		totalTokens: 0,
		totalCost: 0,
		fallbackCount: 0,
	});
});

it("normalizes provider quota entries and derives missing percentages", () => {
	expect(
		parseProviderQuota({
			providers: [
				{ provider: "deepseek", name: "Omniroute", quotaUsed: 25, quotaTotal: 100, resetAt: "2026-11-13T00:00:00Z", tokenStatus: "valid" },
				{ provider: "openrouter", name: "openrouter", quotaUsed: 5, quotaTotal: null },
				{ provider: "codex", name: "codex", quotaUsed: 0, quotaTotal: 10, tokenStatus: "expiring" },
			],
		}),
	).toEqual([
		{ provider: "deepseek", displayName: "Omniroute", quotaUsed: 25, quotaTotal: 100, percentRemaining: 75, resetAt: "2026-11-13T00:00:00Z", tokenStatus: "valid" },
		{ provider: "openrouter", displayName: "openrouter", quotaUsed: 5, quotaTotal: null, percentRemaining: 100, resetAt: null, tokenStatus: "valid" },
		{ provider: "codex", displayName: "codex", quotaUsed: 0, quotaTotal: 10, percentRemaining: 100, resetAt: null, tokenStatus: "expiring" },
	]);
	expect(parseProviderQuota([{ provider: "deepseek", quotaUsed: 50, quotaTotal: 100 }])[0]?.percentRemaining).toBe(50);
	expect(parseProviderQuota({})).toEqual([]);
});

it("loads analytics and quota in parallel for the requested range", async () => {
	fetchStub.mockImplementation(async (input) => {
		const url = String(input);
		if (url.includes("/api/usage/analytics")) {
			return new Response(JSON.stringify({ summary: { totalRequests: 3, totalCost: 0.5, promptTokens: 1000, completionTokens: 200 } }), { status: 200 });
		}
		if (url.endsWith("/api/usage/quota")) {
			return new Response(JSON.stringify({ providers: [{ provider: "deepseek", name: "Omniroute", quotaUsed: 0, quotaTotal: null }] }), { status: 200 });
		}
		return new Response("{}", { status: 200 });
	});

	const report = await loadCostsReport(config, "7d");

	expect(report.denied).toBe(false);
	expect(report.errors).toEqual([]);
	expect(report.summary?.requestCount).toBe(3);
	expect(report.quota[0]).toEqual({ provider: "deepseek", displayName: "Omniroute", quotaUsed: 0, quotaTotal: null, percentRemaining: 100, resetAt: null, tokenStatus: "valid" });
	expect(String(fetchStub.mock.calls[0]?.[0])).toContain("range=7d");
	expect(fetchStub).toHaveBeenCalledWith(
		"http://localhost:20128/api/usage/analytics?range=7d",
		expect.objectContaining({ headers: { Authorization: "Bearer secret" } }),
	);
});

it("flags management-denied keys when usage endpoints reject the request", async () => {
	fetchStub.mockResolvedValue(new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }));

	const report = await loadCostsReport(config);

	expect(report.denied).toBe(true);
	expect(report.summary).toBeUndefined();
	expect(report.quota).toEqual([]);
	expect(report.errors).toHaveLength(2);
});

it("keeps partial data when only one usage endpoint fails", async () => {
	fetchStub.mockImplementation(async (input) => {
		const url = String(input);
		if (url.includes("/api/usage/analytics")) return new Response(JSON.stringify({ summary: { totalRequests: 1 } }), { status: 200 });
		return new Response("nope", { status: 500 });
	});

	const report = await loadCostsReport(config);

	expect(report.denied).toBe(false);
	expect(report.summary?.requestCount).toBe(1);
	expect(report.quota).toEqual([]);
	expect(report.errors).toHaveLength(1);
});

it("formats costs and token counts compactly", () => {
	expect(formatCost(0)).toBe("$0");
	expect(formatCost(0.268815)).toBe("$0.2688");
	expect(formatCost(12.5)).toBe("$12.50");
	expect(formatTokens(0)).toBe("0");
	expect(formatTokens(950)).toBe("950");
	expect(formatTokens(15_267)).toBe("15K");
	expect(formatTokens(3_990_421)).toBe("3.99M");
});

it("renders a report with summary, quota, and range label", () => {
	const report: CostsReport = {
		range: "1d",
		summary: {
			requestCount: 45,
			successRatePct: 100,
			avgLatencyMs: 4315,
			promptTokens: 3_990_421,
			completionTokens: 15_267,
			totalTokens: 4_005_688,
			totalCost: 0.268815,
			fallbackCount: 0,
		},
		quota: [
			{ provider: "deepseek", displayName: "Omniroute", quotaUsed: 25, quotaTotal: 100, percentRemaining: 75, resetAt: null, tokenStatus: "valid" },
			{ provider: "codex", displayName: "codex", quotaUsed: 0, quotaTotal: null, percentRemaining: 100, resetAt: null, tokenStatus: "expiring" },
		],
		denied: false,
		errors: [],
	};

	const text = formatCostsReport(report);

	expect(text).toContain("OmniRoute costs · last 24h");
	expect(text).toContain("Requests   45 · 100.0% success · avg 4.3s");
	expect(text).toContain("Cost       $0.2688");
	expect(text).toContain("Tokens     3.99M in / 15K out");
	expect(text).toContain("Quota");
	expect(text).toContain("deepseek (Omniroute)  75% left · 25 / 100");
	expect(text).toContain("codex  100% left · token expiring");
});

it("explains when the configured key lacks management scope", () => {
	const text = formatCostsReport({ range: "7d", quota: [], denied: true, errors: ["403: forbidden"] });
	expect(text).toContain("management-scoped key");
	expect(text).not.toContain("Partial data");
});
