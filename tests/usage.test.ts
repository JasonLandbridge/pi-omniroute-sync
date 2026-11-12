import { afterEach, expect, it, vi } from "vitest";
import { formatUsageReport, loadUsageReport, parseQuotaWindows, type UsageReport } from "../src/usage.ts";

const fetchStub = vi.spyOn(globalThis, "fetch");
const config = { serverUrl: "http://localhost:20128", apiKey: "secret", providerName: "omni" };

afterEach(() => fetchStub.mockReset());

it("parses quota windows from the provider limits cache", () => {
	const windows = parseQuotaWindows({
		session: { used: 100, total: 100, remainingPercentage: 0, resetAt: "2026-11-13T23:18:06.000Z" },
		weekly: { used: 69, total: 100, resetAt: "2026-11-13T23:18:06.000Z" },
		credits_usd: { used: 0, total: 0, remaining: 10.67, remainingPercentage: 100, unlimited: true, currency: "USD" },
		free_daily: { used: 0, total: 1000, remaining: 1000, remainingPercentage: 100, unlimited: false, displayName: "Free-tier requests (daily)" },
	});

	expect(windows.find((window) => window.key === "session")).toMatchObject({
		remainingPercentage: 0,
		resetAt: "2026-11-13T23:18:06.000Z",
		unlimited: false,
	});
	expect(windows.find((window) => window.key === "weekly")?.remainingPercentage).toBe(31);
	expect(windows.find((window) => window.key === "credits_usd")).toMatchObject({ remaining: 10.67, unlimited: true, currency: "USD" });
	expect(windows.find((window) => window.key === "free_daily")?.displayName).toBe("Free-tier requests (daily)");
	expect(parseQuotaWindows(null)).toEqual([]);
});

it("joins configured connections with cached limits and drops orphan entries", async () => {
	fetchStub.mockImplementation(async (input) => {
		const url = String(input);
		if (url.includes("/api/providers")) {
			return new Response(
				JSON.stringify({
					connections: [
						{ id: "conn-codex", provider: "codex", name: "jason@example.com", authType: "oauth", isActive: true, testStatus: "active" },
						{ id: "conn-openrouter", provider: "openrouter", name: "Openrouter", authType: "apikey", isActive: true, testStatus: "active" },
						{ id: "conn-main", provider: "openai-compatible", name: "main", authType: "apikey", isActive: false, testStatus: "active" },
					],
				}),
				{ status: 200 },
			);
		}
		if (url.endsWith("/api/usage/provider-limits")) {
			return new Response(
				JSON.stringify({
					caches: {
						"conn-codex": {
							plan: "prolite",
							fetchedAt: "2026-11-12T19:06:38.923Z",
							quotas: {
								weekly: { used: 100, total: 100, remainingPercentage: 0, resetAt: "2026-11-13T23:18:06.000Z" },
								session: { used: 100, total: 100, remainingPercentage: 0, resetAt: "2026-11-13T23:18:06.000Z" },
							},
							bankedResetCredits: 2,
						},
						"conn-openrouter": {
							plan: "OpenRouter",
							fetchedAt: "2026-11-12T19:06:38.554Z",
							quotas: { credits: { used: 2.289, total: 10, remaining: 7.7107, remainingPercentage: 77, currency: "USD" } },
						},
						"orphan-conn": { plan: "ghost", quotas: { session: { used: 1, total: 2 } } },
					},
					intervalMinutes: 70,
					lastAutoSyncAt: "2026-11-12T19:06:00.000Z",
				}),
				{ status: 200 },
			);
		}
		return new Response("{}", { status: 200 });
	});

	const report = await loadUsageReport(config);

	expect(report.denied).toBe(false);
	expect(report.errors).toEqual([]);
	expect(report.intervalMinutes).toBe(70);
	expect(report.entries.map((entry) => entry.connectionId)).toEqual(["conn-codex", "conn-openrouter", "conn-main"]);
	expect(report.entries[0]?.bankedResetCredits).toBe(2);
	expect(report.entries[0]?.windows.map((window) => window.key).sort()).toEqual(["session", "weekly"]);
	expect(report.entries[1]?.windows[0]?.key).toBe("credits");
	expect(report.entries[2]?.windows).toEqual([]);
	expect(report.entries.some((entry) => entry.connectionId === "orphan-conn")).toBe(false);
	expect(fetchStub).toHaveBeenCalledWith(
		"http://localhost:20128/api/usage/provider-limits",
		expect.objectContaining({ headers: { Authorization: "Bearer secret" } }),
	);
});

it("flags management-denied keys when the providers endpoint rejects the request", async () => {
	fetchStub.mockImplementation(async (input) =>
		String(input).includes("/api/providers")
			? new Response(JSON.stringify({ error: "forbidden" }), { status: 403 })
			: new Response(JSON.stringify({ caches: {}, intervalMinutes: 70, lastAutoSyncAt: null }), { status: 200 }),
	);

	const report = await loadUsageReport(config);

	expect(report.denied).toBe(true);
	expect(report.entries).toEqual([]);
	expect(report.errors).toHaveLength(1);
});

it("renders codex windows, credits, unlimited balances, and inactive accounts", () => {
	const report: UsageReport = {
		intervalMinutes: 70,
		lastAutoSyncAt: null,
		denied: false,
		errors: [],
		entries: [
			{
				connectionId: "c1",
				provider: "codex",
				name: "jason@example.com",
				isActive: true,
				plan: "prolite",
				fetchedAt: new Date().toISOString(),
				bankedResetCredits: 2,
				windows: [
					{ key: "session", used: 100, total: 100, remainingPercentage: 0, unlimited: false, resetAt: "2026-11-13T23:18:06.000Z" },
					{ key: "weekly", used: 69, total: 100, remainingPercentage: 31, unlimited: false, resetAt: "2026-11-13T23:18:06.000Z" },
				],
			},
			{
				connectionId: "c2",
				provider: "deepseek",
				name: "Omniroute",
				isActive: true,
				plan: "DeepSeek",
				fetchedAt: new Date().toISOString(),
				windows: [{ key: "credits_usd", remaining: 10.67, remainingPercentage: 100, unlimited: true, resetAt: null, currency: "USD" }],
			},
			{
				connectionId: "c3",
				provider: "openrouter",
				name: "Openrouter",
				isActive: true,
				plan: "OpenRouter",
				fetchedAt: new Date().toISOString(),
				windows: [
					{ key: "credits", used: 2.289, total: 10, remaining: 7.7107, remainingPercentage: 77, unlimited: false, resetAt: null, currency: "USD" },
					{ key: "free_daily", used: 0, total: 1000, remaining: 1000, remainingPercentage: 100, unlimited: false, resetAt: "2026-11-13T00:00:00.000Z", displayName: "Free-tier requests (daily)" },
				],
			},
			{ connectionId: "c4", provider: "openai-compatible", name: "main", isActive: false, windows: [] },
			{
				connectionId: "c5",
				provider: "codex",
				name: "old-account",
				isActive: true,
				message: "Codex token expired or access denied. Please re-authenticate the connection.",
				windows: [],
			},
		],
	};

	const text = formatUsageReport(report);

	expect(text).toContain("OmniRoute usage");
	expect(text).toContain("Accounts   4 active");
	expect(text).toContain("codex · jason@example.com · active · prolite");
	expect(text).toContain("5h window  0% left · 100/100 used · resets 2026-11-13 23:18Z");
	expect(text).toContain("weekly window  31% left · 69/100 used");
	expect(text).toContain("banked resets  2");
	expect(text).toContain("credits  $10.67 left (unlimited)");
	expect(text).toContain("credits  $7.71 of $10.00 left (77% left)");
	expect(text).toContain("Free-tier requests (daily)  100% left · 0/1000 used · 1000 left");
	expect(text).toContain("openai-compatible · main · inactive");
	expect(text).toContain("no limits reported (unsupported provider or not synced yet)");
	expect(text).toContain("⚠ Codex token expired");
});

it("parses banked reset expirations from object and sibling expiry fields", async () => {
	fetchStub.mockImplementation(async (input) => {
		const url = String(input);
		if (url.includes("/api/providers")) {
			return new Response(
				JSON.stringify({
					connections: [
						{ id: "conn-a", provider: "codex", name: "a", isActive: true },
						{ id: "conn-b", provider: "codex", name: "b", isActive: true },
					],
				}),
				{ status: 200 },
			);
		}
		return new Response(
			JSON.stringify({
				caches: {
					"conn-a": { bankedResetCredits: { count: 2, expirations: ["2026-12-01T10:00:00.000Z", "2027-01-05T09:00:00.000Z"] } },
					"conn-b": { bankedResetCredits: 1, bankedResetExpirations: ["2026-12-20T00:00:00.000Z"] },
				},
				intervalMinutes: 70,
				lastAutoSyncAt: null,
			}),
			{ status: 200 },
		);
	});

	const report = await loadUsageReport(config);

	expect(report.entries[0]?.bankedResetCredits).toBe(2);
	expect(report.entries[0]?.bankedResetExpirations).toEqual(["2026-12-01T10:00:00.000Z", "2027-01-05T09:00:00.000Z"]);
	expect(report.entries[1]?.bankedResetCredits).toBe(1);
	expect(report.entries[1]?.bankedResetExpirations).toEqual(["2026-12-20T00:00:00.000Z"]);
});

it("renders banked reset expiration datetimes when the gateway reports them", () => {
	const report: UsageReport = {
		intervalMinutes: 70,
		lastAutoSyncAt: null,
		denied: false,
		errors: [],
		entries: [
			{
				connectionId: "c1",
				provider: "codex",
				name: "a",
				isActive: true,
				bankedResetCredits: 2,
				bankedResetExpirations: ["2026-12-01T10:00:00.000Z", "2027-01-05T09:00:00.000Z"],
				windows: [],
			},
		],
	};

	const text = formatUsageReport(report);

	expect(text).toContain("banked resets  2 · expiring 2026-12-01 10:00Z, 2027-01-05 09:00Z");
});

it("explains when the configured key lacks management scope", () => {
	const text = formatUsageReport({ entries: [], intervalMinutes: 70, lastAutoSyncAt: null, denied: true, errors: ["403: forbidden"] });
	expect(text).toContain("management-scoped key");
});
