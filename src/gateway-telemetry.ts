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

export function formatGatewayTokensPerSecond(tps: number | undefined): string {
	return tps === undefined ? "—" : tps.toFixed(1);
}
