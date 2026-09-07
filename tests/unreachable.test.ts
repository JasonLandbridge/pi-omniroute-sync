import { describe, expect, it, vi } from "vitest";
import {
	createUnreachableController,
	hopOnUnreachable,
	hopOptionsFromContext,
	isOmniActiveModel,
	isUnreachableHttpStatus,
	isUnreachableRequestFailure,
	parseFallbackModel,
	shouldAttemptHop,
} from "../src/unreachable.ts";
import type { OmniContext } from "../src/contracts.ts";

const hopBase = {
	onUnreachable: "host-fallback" as const,
	fallbackModel: "anthropic/claude-sonnet-4",
	omniProviderName: "omni",
	currentProvider: "omni",
	currentModelId: "auto",
};

describe("parseFallbackModel", () => {
	it("requires a host provider/id", () => {
		expect(parseFallbackModel("anthropic/claude-sonnet-4")).toEqual({
			provider: "anthropic",
			id: "claude-sonnet-4",
		});
		expect(parseFallbackModel("openrouter/anthropic/claude-sonnet-4")).toEqual({
			provider: "openrouter",
			id: "anthropic/claude-sonnet-4",
		});
		expect(parseFallbackModel("")).toBeUndefined();
		expect(parseFallbackModel("claude-sonnet-4")).toBeUndefined();
		expect(parseFallbackModel("/missing-provider")).toBeUndefined();
	});
});

describe("shouldAttemptHop", () => {
	it("stays status-only when the hook is disabled", () => {
		expect(shouldAttemptHop({ ...hopBase, onUnreachable: "none" })).toBe(false);
	});

	it("does not hop when the active model is already a non-omni host provider", () => {
		expect(shouldAttemptHop({ ...hopBase, currentProvider: "anthropic", currentModelId: "claude-sonnet-4" })).toBe(false);
	});

	it("does not hop when already on the fallback model", () => {
		expect(shouldAttemptHop({ ...hopBase, currentProvider: "anthropic", currentModelId: "claude-sonnet-4" })).toBe(false);
	});

	it("requires a parseable fallback model", () => {
		expect(shouldAttemptHop({ ...hopBase, fallbackModel: "" })).toBe(false);
	});

	it("rejects another OmniRoute model as a host fallback", () => {
		expect(shouldAttemptHop({ ...hopBase, fallbackModel: "omni/auto/coding" })).toBe(false);
	});

	it("hops from an omni model to a configured host fallback", () => {
		expect(shouldAttemptHop(hopBase)).toBe(true);
	});
});

describe("isOmniActiveModel and unreachable status", () => {
	it("treats a missing provider as the OmniRoute model", () => {
		expect(isOmniActiveModel(undefined, "omni")).toBe(true);
		expect(isOmniActiveModel({ provider: "omni" }, "omni")).toBe(true);
		expect(isOmniActiveModel({ provider: "anthropic" }, "omni")).toBe(false);
	});

	it("treats connect failures, timeouts, and 5xx as unreachable", () => {
		expect(isUnreachableHttpStatus(undefined)).toBe(true);
		expect(isUnreachableHttpStatus(0)).toBe(true);
		expect(isUnreachableHttpStatus(408)).toBe(true);
		expect(isUnreachableHttpStatus(502)).toBe(true);
		expect(isUnreachableHttpStatus(200)).toBe(false);
		expect(isUnreachableHttpStatus(401)).toBe(false);
		expect(isUnreachableHttpStatus(429)).toBe(false);
	});

	it("recognizes thrown OmniRoute timeout and connection failures only", () => {
		expect(isUnreachableRequestFailure({ role: "assistant", provider: "omni", stopReason: "error", errorMessage: "fetch failed: ECONNREFUSED" }, "omni")).toBe(true);
		expect(isUnreachableRequestFailure({ role: "assistant", provider: "omni", stopReason: "error", errorMessage: "Request timed out" }, "omni")).toBe(true);
		expect(isUnreachableRequestFailure({ role: "assistant", provider: "omni", stopReason: "error", errorMessage: "Connection error." }, "omni")).toBe(true);
		expect(isUnreachableRequestFailure({ role: "assistant", provider: "omni", stopReason: "error", errorMessage: "401: invalid API key" }, "omni")).toBe(false);
		expect(isUnreachableRequestFailure({ role: "assistant", provider: "omni", stopReason: "aborted", errorMessage: "Request timed out" }, "omni")).toBe(false);
		expect(isUnreachableRequestFailure({ role: "assistant", provider: "anthropic", stopReason: "error", errorMessage: "502: bad gateway" }, "omni")).toBe(false);
	});
});

describe("hopOnUnreachable", () => {
	it("calls the host setModel hook for the fallback provider/id", async () => {
		const fallback = { provider: "anthropic", id: "claude-sonnet-4" };
		const setModel = vi.fn(async () => true);
		const notify = vi.fn();
		const hopped = await hopOnUnreachable(
			{ serverUrl: "http://localhost:20128", reason: "probe" },
			{
				...hopBase,
				findModel: (provider, id) => (provider === fallback.provider && id === fallback.id ? fallback : undefined),
				setModel,
				notify,
			},
		);
		expect(hopped).toBe(true);
		expect(setModel).toHaveBeenCalledWith(fallback);
		expect(notify).toHaveBeenCalledWith(
			"OmniRoute unreachable at http://localhost:20128; hopped to anthropic/claude-sonnet-4.",
			"warning",
		);
	});

	it("keeps the model registry receiver when resolving the fallback", async () => {
		const fallback = { provider: "anthropic", id: "claude-sonnet-4" };
		const registry = {
			find(provider: string, id: string) {
				return this === registry && provider === fallback.provider && id === fallback.id ? fallback : undefined;
			},
		};
		const setModel = vi.fn(async () => true);
		const context = {
			hasUI: false,
			mode: "tui",
			ui: {} as OmniContext["ui"],
			model: { provider: "omni", id: "auto" },
			modelRegistry: registry,
		} as OmniContext;

		expect(await hopOnUnreachable(
			{ serverUrl: "http://localhost:20128", reason: "probe" },
			hopOptionsFromContext(context, hopBase, setModel),
		)).toBe(true);
		expect(setModel).toHaveBeenCalledWith(fallback);
	});

	it("notifies instead of silently doing nothing when the fallback is empty", async () => {
		const notify = vi.fn();
		const hopped = await hopOnUnreachable(
			{ serverUrl: "http://gateway.example", reason: "probe" },
			{ ...hopBase, fallbackModel: "", notify },
		);
		expect(hopped).toBe(false);
		expect(notify).toHaveBeenCalledWith(
			"OmniRoute unreachable at http://gateway.example. Configure fallbackModel as an authenticated host provider/id, or use /model <provider/id> manually.",
			"warning",
		);
	});

	it("does not invent a second omni provider when the host cannot switch", async () => {
		const notify = vi.fn();
		const hopped = await hopOnUnreachable(
			{ serverUrl: "http://gateway.example", reason: "request-failure", status: 504 },
			{ ...hopBase, notify },
		);
		expect(hopped).toBe(false);
		expect(notify).toHaveBeenCalledWith(
			"OmniRoute unreachable at http://gateway.example. Host fallback anthropic/claude-sonnet-4 is unavailable. Use /model anthropic/claude-sonnet-4.",
			"warning",
		);
	});

	it("is a no-op when the hook is off", async () => {
		const setModel = vi.fn(async () => true);
		expect(
			await hopOnUnreachable(
				{ serverUrl: "http://localhost:20128", reason: "probe" },
				{ ...hopBase, onUnreachable: "none", setModel },
			),
		).toBe(false);
		expect(setModel).not.toHaveBeenCalled();
	});
});

describe("createUnreachableController", () => {
	it("probes the given serverUrl and coalesces in-flight checks", async () => {
		const fetchStub = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
		const controller = createUnreachableController();
		const config = { serverUrl: "http://configured.example", apiKey: "", providerName: "omni" };
		const [first, second] = await Promise.all([controller.probe(config), controller.probe(config)]);
		expect(first).toBe(true);
		expect(second).toBe(true);
		expect(fetchStub).toHaveBeenCalledTimes(1);
		expect(fetchStub).toHaveBeenCalledWith(
			"http://configured.example/api/health/ping",
			expect.objectContaining({}),
		);
		fetchStub.mockRestore();
	});
});
