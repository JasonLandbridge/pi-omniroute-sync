export function tokensPerSecondFromUsage(usage: unknown): number | undefined {
	if (!usage || typeof usage !== "object") return undefined;
	const record = usage as Record<string, unknown>;
	const raw = record.tokens_per_second ?? record.tokensPerSecond;
	if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return raw;
	if (typeof raw === "string" && raw.trim() !== "") {
		const parsed = Number(raw);
		if (Number.isFinite(parsed) && parsed > 0) return parsed;
	}
	return undefined;
}

export function parseOmniRouteToksHeader(headers: Headers): number | undefined {
	const raw = headers.get("x-omniroute-tokens-per-second");
	if (!raw) return undefined;
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function wrapFetchCaptureTokensPerSecond(
	fetchImpl: typeof fetch,
	onCapture: (tps: number) => void,
): typeof fetch {
	return async (input, init) => {
		const response = await fetchImpl(input, init);
		const tps = parseOmniRouteToksHeader(response.headers);
		if (tps !== undefined) onCapture(tps);
		return response;
	};
}

export function formatGatewayTokensPerSecond(tps: number | undefined): string {
	return tps === undefined ? "—" : tps.toFixed(1);
}

export function registerGatewayTelemetry(pi: {
	on(event: string, handler: (...args: never[]) => unknown): void;
}): void {
	let captured: number | undefined;
	let restoreFetch: (() => void) | undefined;

	const install = () => {
		if (restoreFetch) return;
		const originalFetch = globalThis.fetch.bind(globalThis);
		globalThis.fetch = wrapFetchCaptureTokensPerSecond(originalFetch, (tps) => {
			captured = tps;
		});
		restoreFetch = () => {
			globalThis.fetch = originalFetch;
		};
	};

	pi.on("session_start", (() => {
		captured = undefined;
		install();
	}) as (...args: never[]) => unknown);

	pi.on("agent_settled", ((event: unknown, ctx: unknown) => {
		const payload = event as { messages?: Array<{ usage?: unknown }> };
		const ui = ctx as { hasUI?: boolean; ui?: { notify?: (message: string, type?: string) => void } };
		const fromUsage = (payload.messages ?? [])
			.map((message) => tokensPerSecondFromUsage(message.usage))
			.find((value) => value !== undefined);
		const tps = captured ?? fromUsage;
		if (ui.hasUI) ui.ui?.notify?.(`tok/s ${formatGatewayTokensPerSecond(tps)}`, "info");
		captured = undefined;
	}) as (...args: never[]) => unknown);

	pi.on("session_shutdown", (() => {
		restoreFetch?.();
		restoreFetch = undefined;
		captured = undefined;
	}) as (...args: never[]) => unknown);
}
