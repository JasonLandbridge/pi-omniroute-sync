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

export interface CostsReport {
	range: CostRange;
	summary?: CostsSummary;
	/** True when the analytics endpoint rejected the key (401/403). */
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

function statusOf(reason: unknown): number | undefined {
	if (reason && typeof reason === "object" && "status" in reason) {
		return typeof reason.status === "number" ? reason.status : undefined;
	}
	return undefined;
}

export async function loadCostsReport(config: OmniConfig, range: CostRange = "1d", signal?: AbortSignal): Promise<CostsReport> {
	const errors: string[] = [];
	let denied = false;
	let summary: CostsSummary | undefined;
	try {
		summary = parseCostsSummary(await requestJson(config, `/api/usage/analytics?range=${encodeURIComponent(range)}`, signal));
	} catch (error) {
		const status = statusOf(error);
		if (status === 401 || status === 403) denied = true;
		errors.push(error instanceof Error ? error.message : String(error));
	}

	return { range, summary, denied, errors };
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
	if (report.denied) {
		lines.push("", "Cost analytics needs a management-scoped key (manage/admin). Re-run /omni setup with such a key. For remaining limits, use /omni usage.");
	} else if (report.errors.length > 0) {
		lines.push("", report.summary ? `Partial data: ${report.errors[0]}` : `Cost data unavailable: ${report.errors[0]}`);
	}
	if (lines.length === 1) lines.push("No usage recorded for this range.");
	return lines.join("\n");
}
