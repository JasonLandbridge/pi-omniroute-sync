import type { OmniPI } from "./contracts.ts";

type FetchInput = Parameters<typeof fetch>[0];
type HeaderSource = Headers | Record<string, string>;

function positiveNumber(raw: unknown): number | undefined {
	const parsed = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.trim()) : NaN;
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function tokensPerSecondFromUsage(usage: unknown): number | undefined {
	if (!usage || typeof usage !== "object") return undefined;
	const record = usage as Record<string, unknown>;
	return positiveNumber(record.tokens_per_second ?? record.tokensPerSecond);
}

function headerValue(headers: HeaderSource): string | undefined {
	if (headers instanceof Headers) return headers.get("x-omniroute-tokens-per-second") ?? undefined;
	return Object.entries(headers).find(([name]) => name.toLowerCase() === "x-omniroute-tokens-per-second")?.[1];
}

export function parseOmniRouteToksHeader(headers: HeaderSource): number | undefined {
	return positiveNumber(headerValue(headers));
}

function tokensPerSecondFromPayload(payload: unknown, depth = 0): number | undefined {
	if (!payload || typeof payload !== "object" || depth > 8) return undefined;
	const direct = tokensPerSecondFromUsage(payload);
	if (direct !== undefined) return direct;
	for (const value of Object.values(payload)) {
		const nested = tokensPerSecondFromPayload(value, depth + 1);
		if (nested !== undefined) return nested;
	}
	return undefined;
}

function tokensPerSecondFromSseLine(line: string): number | undefined {
	const comment = /^\s*:\s*x-omniroute-tokens-per-second\s*=\s*(.+?)\s*$/i.exec(line);
	if (comment) return positiveNumber(comment[1]);
	if (!line.trimStart().startsWith("data:")) return undefined;
	const data = line.slice(line.indexOf(":") + 1).trim();
	if (!data || data === "[DONE]") return undefined;
	try {
		return tokensPerSecondFromPayload(JSON.parse(data));
	} catch {
		return undefined;
	}
}

async function captureSseTokensPerSecond(response: Response, onCapture: (tps: number) => void): Promise<void> {
	const reader = response.body?.getReader();
	if (!reader) return;
	const decoder = new TextDecoder();
	let buffer = "";
	let captured: number | undefined;
	const consumeLine = (line: string) => {
		const tps = tokensPerSecondFromSseLine(line);
		if (tps !== undefined) captured = tps;
	};

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split(/\r?\n/);
			buffer = lines.pop() ?? "";
			for (const line of lines) consumeLine(line);
		}
		buffer += decoder.decode();
		if (buffer) consumeLine(buffer);
		if (captured !== undefined) onCapture(captured);
	} finally {
		reader.releaseLock();
	}
}

export async function captureTokensPerSecondFromResponse(response: Response, onCapture: (tps: number) => void): Promise<void> {
	try {
		const contentType = response.headers.get("content-type") ?? "";
		if (contentType.toLowerCase().includes("text/event-stream")) {
			await captureSseTokensPerSecond(response, onCapture);
			return;
		}
		if (!contentType.toLowerCase().includes("json")) return;
		const tps = tokensPerSecondFromPayload(await response.json());
		if (tps !== undefined) onCapture(tps);
	} catch {
		// Telemetry must never interfere with the provider response.
	}
}

export function isOmniRouteInferenceRequest(input: FetchInput, serverUrl: string): boolean {
	try {
		const base = new URL(serverUrl);
		const requestUrl = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, base);
		const prefix = `${base.pathname.replace(/\/+$/, "")}/v1`;
		return (
			requestUrl.origin === base.origin &&
			(requestUrl.pathname === `${prefix}/chat/completions` || requestUrl.pathname === `${prefix}/responses`)
		);
	} catch {
		return false;
	}
}

export function wrapFetchCaptureTokensPerSecond(
	fetchImpl: typeof fetch,
	onCapture: (tps: number | undefined, input: FetchInput, response: Response) => void,
): typeof fetch {
	return async (input, init) => {
		const response = await fetchImpl(input, init);
		onCapture(parseOmniRouteToksHeader(response.headers), input, response);
		return response;
	};
}

export function formatGatewayTokensPerSecond(tps: number | undefined): string {
	return tps === undefined ? "—" : tps.toFixed(1);
}

export function registerGatewayTelemetry(
	pi: OmniPI,
	options: { providerName: () => string; serverUrl: () => string; showTokensPerSecond: () => boolean },
): void {
	let captured: number | undefined;
	let activeProvider: string | undefined;
	let activeRunId = 0;
	let observedInference = false;
	let nextRunId = 0;
	let nextResponseId = 0;
	let latestResponseId = 0;
	let restoreFetch: (() => void) | undefined;
	const pendingCaptures = new Set<Promise<void>>();

	const isActiveRun = () => activeRunId !== 0;
	const isActiveOmniRun = () => isActiveRun() && activeProvider === options.providerName();
	const isDisplayEnabled = () => options.showTokensPerSecond();
	const resetRun = () => {
		captured = undefined;
		activeProvider = undefined;
		activeRunId = 0;
		observedInference = false;
		latestResponseId = 0;
	};

	const trackResponse = (tps: number | undefined, input: FetchInput, response: Response) => {
		// The host may expose the routed model's alias instead of the registered provider name;
		// the configured inference URL is the reliable association boundary.
		if (!isActiveRun() || !isDisplayEnabled() || !isOmniRouteInferenceRequest(input, options.serverUrl())) return;
		observedInference = true;
		const runId = activeRunId;
		const responseId = ++nextResponseId;
		latestResponseId = responseId;
		captured = response.ok ? tps : undefined;
		if (!response.ok) return;

		let clone: Response;
		try {
			clone = response.clone();
		} catch {
			return;
		}
		const capture = captureTokensPerSecondFromResponse(clone, (bodyTps) => {
			if (runId === activeRunId && responseId === latestResponseId && isActiveRun()) captured = bodyTps;
		});
		pendingCaptures.add(capture);
		void capture.then(
			() => pendingCaptures.delete(capture),
			() => pendingCaptures.delete(capture),
		);
	};

	const install = () => {
		if (restoreFetch) return;
		const originalFetch = globalThis.fetch;
		const wrappedFetch = wrapFetchCaptureTokensPerSecond(originalFetch.bind(globalThis), trackResponse);
		globalThis.fetch = wrappedFetch;
		restoreFetch = () => {
			if (globalThis.fetch === wrappedFetch) globalThis.fetch = originalFetch;
		};
	};

	pi.on("session_start", () => {
		resetRun();
		install();
	});

	pi.on("agent_start", (_event, ctx) => {
		activeRunId = ++nextRunId;
		activeProvider = ctx.model?.provider;
		captured = undefined;
		latestResponseId = 0;
	});

	pi.on("after_provider_response", (event, ctx) => {
		if (!isActiveOmniRun() || !isDisplayEnabled() || ctx.model?.provider !== options.providerName()) return;
		observedInference = true;
		captured = event.status >= 200 && event.status < 300 ? parseOmniRouteToksHeader(event.headers) : undefined;
	});

	pi.on("agent_settled", async (_event, ctx) => {
		const runId = activeRunId;
		await Promise.all([...pendingCaptures]);
		if (runId !== activeRunId) return;
		if (observedInference && isDisplayEnabled() && ctx.hasUI) ctx.ui.notify(`tok/s ${formatGatewayTokensPerSecond(captured)}`, "info");
		resetRun();
	});

	pi.on("session_shutdown", () => {
		restoreFetch?.();
		restoreFetch = undefined;
		resetRun();
	});
}
