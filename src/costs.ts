import type { OmniConfig } from "./config.ts";

export const COST_RANGES = ["1d", "7d", "30d", "90d", "ytd", "all"] as const;
export type CostRange = (typeof COST_RANGES)[number];

export interface CostsSummary {
	requestCount: number;
	successRatePct: number;
	avgLatencyMs: number;
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
	totalCost: number;
	fallbackCount: number;
}

export interface ProviderQuota {
	provider: string;
	displayName?: string;
	quotaUsed: number;
	quotaTotal: number | null;
	percentRemaining: number;
	resetAt: string | null;
	tokenStatus: string;
}

export interface CostsReport {
	range: CostRange;
	summary?: CostsSummary;
	quota: ProviderQuota[];
	/** True when a management endpoint rejected the key (401/403). */
	denied: boolean;
	errors: string[];
}

async function requestJson<T>(config: OmniConfig, path: string, signal?: AbortSignal): Promise<T> {
	const requestTimeout = AbortSignal.timeout(8_000);
	const res = await fetch(`${config.serverUrl}${path}`, {
		headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {},
		signal: signal ? AbortSignal.any([signal, requestTimeout]) : requestTimeout,
	});
	const text = await res.text();
	if (!res.ok) throw Object.assign(new Error(`${res.status}: ${text || res.statusText}`), { status: res.status });
	return (text ? JSON.parse(text) : {}) as T;
}

function toOptionalNumber(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return null;
}

function toRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function parseCostsSummary(raw: unknown): CostsSummary {
	const summary = toRecord(toRecord(raw).summary);
	const num = (value: unknown): number => toOptionalNumber(value) ?? 0;
	return {
		requestCount: num(summary.totalRequests),
		successRatePct: num(summary.successRatePct),
		avgLatencyMs: num(summary.avgLatencyMs),
		promptTokens: num(summary.promptTokens),
		completionTokens: num(summary.completionTokens),
		totalTokens: num(summary.totalTokens),
		totalCost: num(summary.totalCost),
		fallbackCount: num(summary.fallbackCount),
	};
}

/** Mirrors OmniRoute's `sanitizeQuotaProvider` so raw and normalized payloads both parse. */
export function parseProviderQuota(raw: unknown): ProviderQuota[] {
	const source = toRecord(raw);
	const providers = Array.isArray(source.providers) ? source.providers : Array.isArray(raw) ? raw : [];
	return providers.map((item) => {
		const entry = toRecord(item);
		const provider = typeof entry.provider === "string" && entry.provider.trim() ? entry.provider : "unknown";
		const name = typeof entry.name === "string" && entry.name.trim() ? entry.name : undefined;
		const quotaTotalRaw = toOptionalNumber(entry.quotaTotal);
		const quotaTotal = quotaTotalRaw !== null && quotaTotalRaw >= 0 ? quotaTotalRaw : null;
		const quotaUsedRaw = toOptionalNumber(entry.quotaUsed) ?? 0;
		const quotaUsed = quotaTotal !== null ? Math.min(Math.max(quotaUsedRaw, 0), quotaTotal) : Math.max(0, quotaUsedRaw);
		let percentRemaining = toOptionalNumber(entry.percentRemaining);
		if (percentRemaining === null) {
			percentRemaining = quotaTotal !== null && quotaTotal > 0 ? ((quotaTotal - quotaUsed) / quotaTotal) * 100 : 100;
		}
		return {
			provider,
			displayName: name,
			quotaUsed,
			quotaTotal,
			percentRemaining: Math.min(100, Math.max(0, percentRemaining)),
			resetAt: typeof entry.resetAt === "string" && entry.resetAt.trim() ? entry.resetAt : null,
			tokenStatus: typeof entry.tokenStatus === "string" && entry.tokenStatus.trim() ? entry.tokenStatus : "valid",
		};
	});
}

function statusOf(reason: unknown): number | undefined {
	if (reason && typeof reason === "object" && "status" in reason) {
		return typeof reason.status === "number" ? reason.status : undefined;
	}
	return undefined;
}

export async function loadCostsReport(config: OmniConfig, range: CostRange = "1d", signal?: AbortSignal): Promise<CostsReport> {
	const [analyticsResult, quotaResult] = await Promise.allSettled([
		requestJson(config, `/api/usage/analytics?range=${encodeURIComponent(range)}`, signal),
		requestJson(config, "/api/usage/quota", signal),
	]);

	const errors: string[] = [];
	let denied = false;
	const noteFailure = (result: PromiseSettledResult<unknown>): void => {
		if (result.status === "fulfilled") return;
		const status = statusOf(result.reason);
		if (status === 401 || status === 403) denied = true;
		errors.push(result.reason instanceof Error ? result.reason.message : String(result.reason));
	};

	let summary: CostsSummary | undefined;
	if (analyticsResult.status === "fulfilled") summary = parseCostsSummary(analyticsResult.value);
	else noteFailure(analyticsResult);

	let quota: ProviderQuota[] = [];
	if (quotaResult.status === "fulfilled") quota = parseProviderQuota(quotaResult.value);
	else noteFailure(quotaResult);

	return { range, summary, quota, denied, errors };
}

export function formatTokens(value: number): string {
	if (!Number.isFinite(value) || value <= 0) return "0";
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 2).replace(/\.?0+$/, "")}M`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1).replace(/\.0$/, "")}K`;
	return String(Math.round(value));
}

export function formatCost(value: number): string {
	if (!Number.isFinite(value) || value <= 0) return "$0";
	return value < 1 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

function rangeLabel(range: CostRange): string {
	if (range === "1d") return "last 24h";
	if (range === "ytd") return "year to date";
	return `last ${range}`;
}

function quotaLine(entry: ProviderQuota): string {
	const name = entry.displayName && entry.displayName !== entry.provider ? `${entry.provider} (${entry.displayName})` : entry.provider;
	const parts = [`${Math.round(entry.percentRemaining)}% left`];
	if (entry.quotaTotal !== null) {
		parts.push(`${formatTokens(entry.quotaUsed)} / ${formatTokens(entry.quotaTotal)}`);
	} else if (entry.quotaUsed > 0) {
		parts.push(`${formatTokens(entry.quotaUsed)} used · no limit reported`);
	}
	if (entry.resetAt) parts.push(`resets ${entry.resetAt}`);
	if (entry.tokenStatus !== "valid") parts.push(`token ${entry.tokenStatus}`);
	return `${name}  ${parts.join(" · ")}`;
}

export function formatCostsReport(report: CostsReport): string {
	const lines = [`OmniRoute costs · ${rangeLabel(report.range)}`];
	const summary = report.summary;
	if (summary) {
		const requestsLine =
			summary.requestCount > 0
				? `${summary.requestCount} · ${summary.successRatePct.toFixed(1)}% success · avg ${(summary.avgLatencyMs / 1000).toFixed(1)}s`
				: "0";
		lines.push(
			`Requests   ${requestsLine}`,
			`Cost       ${formatCost(summary.totalCost)}`,
			`Tokens     ${formatTokens(summary.promptTokens)} in / ${formatTokens(summary.completionTokens)} out`,
		);
		if (summary.fallbackCount > 0) lines.push(`Fallbacks  ${summary.fallbackCount}`);
	}
	if (report.quota.length > 0) {
		lines.push("", "Quota");
		for (const entry of report.quota) lines.push(`  ${quotaLine(entry)}`);
	}
	if (report.denied) {
		lines.push("", "Usage and quota endpoints need a management-scoped key (manage/admin). Re-run /omni setup with such a key.");
	} else if (report.errors.length > 0) {
		lines.push("", report.summary || report.quota.length > 0 ? `Partial data: ${report.errors[0]}` : `Usage data unavailable: ${report.errors[0]}`);
	}
	if (lines.length === 1) lines.push("No usage recorded for this range.");
	return lines.join("\n");
}
