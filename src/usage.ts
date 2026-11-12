import type { OmniConfig } from "./config.ts";
import { formatCost } from "./costs.ts";

export interface QuotaWindow {
	key: string;
	used?: number;
	total?: number;
	remaining?: number;
	remainingPercentage?: number;
	unlimited: boolean;
	resetAt: string | null;
	currency?: string;
	displayName?: string;
}

export interface UsageAccount {
	connectionId: string;
	provider: string;
	name?: string;
	authType?: string;
	isActive: boolean;
	testStatus?: string;
	plan?: string;
	fetchedAt?: string;
	message?: string;
	bankedResetCredits?: number;
	/** Expiry datetimes for banked reset credits, when the gateway reports them. */
	bankedResetExpirations?: string[];
	windows: QuotaWindow[];
}

export interface UsageReport {
	entries: UsageAccount[];
	intervalMinutes: number;
	lastAutoSyncAt: string | null;
	denied: boolean;
	errors: string[];
}

const DEFAULT_SYNC_INTERVAL_MINUTES = 70;

function toRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function toOptionalNumber(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return null;
}

export function parseQuotaWindows(quotas: unknown): QuotaWindow[] {
	return Object.entries(toRecord(quotas)).map(([key, raw]) => {
		const entry = toRecord(raw);
		const used = toOptionalNumber(entry.used);
		const total = toOptionalNumber(entry.total);
		const remaining = toOptionalNumber(entry.remaining);
		let remainingPercentage = toOptionalNumber(entry.remainingPercentage);
		if (remainingPercentage === null && total !== null && total > 0 && used !== null) {
			remainingPercentage = ((total - used) / total) * 100;
		}
		const displayName = typeof entry.displayName === "string" && entry.displayName.trim() ? entry.displayName.trim() : undefined;
		return {
			key,
			used: used ?? undefined,
			total: total ?? undefined,
			remaining: remaining ?? undefined,
			remainingPercentage: remainingPercentage === null ? undefined : Math.max(0, Math.min(100, remainingPercentage)),
			unlimited: entry.unlimited === true,
			resetAt: typeof entry.resetAt === "string" && entry.resetAt.trim() ? entry.resetAt : null,
			currency: typeof entry.currency === "string" && entry.currency.trim() ? entry.currency.trim() : undefined,
			displayName,
		};
	});
}

async function requestJson<T>(config: OmniConfig, path: string, signal?: AbortSignal): Promise<T> {
	const requestTimeout = AbortSignal.timeout(10_000);
	const res = await fetch(`${config.serverUrl}${path}`, {
		headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {},
		signal: signal ? AbortSignal.any([signal, requestTimeout]) : requestTimeout,
	});
	const text = await res.text();
	if (!res.ok) throw Object.assign(new Error(`${res.status}: ${text || res.statusText}`), { status: res.status });
	return (text ? JSON.parse(text) : {}) as T;
}

function statusOf(reason: unknown): number | undefined {
	if (reason && typeof reason === "object" && "status" in reason) {
		return typeof reason.status === "number" ? reason.status : undefined;
	}
	return undefined;
}

function collectExpiry(value: unknown, target: Set<string>): void {
	if (typeof value === "string") {
		const timestamp = Date.parse(value);
		if (Number.isFinite(timestamp)) target.add(new Date(timestamp).toISOString());
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) collectExpiry(item, target);
		return;
	}
	if (value && typeof value === "object") {
		const record = toRecord(value);
		collectExpiry(
			record.expiresAt ?? record.expires_at ?? record.expiration ?? record.expires ?? record.expiry ?? record.credits ?? record.items,
			target,
		);
	}
}

// The gateway currently reports only a count (`bankedResetCredits: 2`). These
// candidate fields keep the report ready for a future gateway version that
// exposes expiry datetimes; ask upstream for the field:
// https://github.com/diegosouzapw/OmniRoute/issues (reset-credit expiry request).
const BANKED_RESET_EXPIRY_FIELDS = [
	"bankedResetExpirations",
	"bankedResetCreditsExpiresAt",
	"bankedResetCreditExpirations",
	"resetCreditExpirations",
	"rateLimitResetCredits",
] as const;

function parseBankedResets(cache: Record<string, unknown>): { count?: number; expirations: string[] } {
	const expirations = new Set<string>();
	const raw = cache.bankedResetCredits;
	let count: number | undefined;
	if (typeof raw === "number" || typeof raw === "string") {
		count = toOptionalNumber(raw) ?? undefined;
	} else if (raw && typeof raw === "object") {
		const record = toRecord(raw);
		count = toOptionalNumber(record.count ?? record.availableCount ?? record.available_count) ?? undefined;
		collectExpiry(record.expirations ?? record.expiresAt ?? record.expires_at ?? record.credits ?? record.items, expirations);
	}
	for (const field of BANKED_RESET_EXPIRY_FIELDS) collectExpiry(cache[field], expirations);
	return { count, expirations: [...expirations].sort() };
}

export async function loadUsageReport(config: OmniConfig, signal?: AbortSignal): Promise<UsageReport> {
	const [connectionsResult, limitsResult] = await Promise.allSettled([
		requestJson(config, "/api/providers?limit=10000", signal),
		requestJson(config, "/api/usage/provider-limits", signal),
	]);

	const errors: string[] = [];
	let denied = false;
	const noteFailure = (result: PromiseSettledResult<unknown>): void => {
		if (result.status === "fulfilled") return;
		const status = statusOf(result.reason);
		if (status === 401 || status === 403) denied = true;
		errors.push(result.reason instanceof Error ? result.reason.message : String(result.reason));
	};

	const connectionsRaw = connectionsResult.status === "fulfilled" ? toRecord(connectionsResult.value).connections : undefined;
	const connections = Array.isArray(connectionsRaw) ? connectionsRaw.filter((item) => item && typeof item === "object") : [];
	if (connectionsResult.status === "rejected") noteFailure(connectionsResult);

	const cachesRaw = limitsResult.status === "fulfilled" ? toRecord(toRecord(limitsResult.value).caches) : {};
	if (limitsResult.status === "rejected") noteFailure(limitsResult);

	let intervalMinutes = DEFAULT_SYNC_INTERVAL_MINUTES;
	let lastAutoSyncAt: string | null = null;
	if (limitsResult.status === "fulfilled") {
		const meta = toRecord(limitsResult.value);
		const interval = toOptionalNumber(meta.intervalMinutes);
		if (interval !== null && interval > 0) intervalMinutes = interval;
		lastAutoSyncAt = typeof meta.lastAutoSyncAt === "string" && meta.lastAutoSyncAt.trim() ? meta.lastAutoSyncAt : null;
	}

	const entries: UsageAccount[] = connections.map((raw) => {
		const connection = toRecord(raw);
		const connectionId = typeof connection.id === "string" ? connection.id : "";
		const provider = typeof connection.provider === "string" ? connection.provider : "unknown";
		const cache = toRecord(cachesRaw[connectionId]);
		const plan = typeof cache.plan === "string" && cache.plan.trim() ? cache.plan.trim() : undefined;
		const banked = parseBankedResets(cache);
		return {
			connectionId,
			provider,
			name: typeof connection.name === "string" && connection.name.trim() ? connection.name.trim() : undefined,
			authType: typeof connection.authType === "string" ? connection.authType : undefined,
			isActive: connection.isActive === true,
			testStatus: typeof connection.testStatus === "string" ? connection.testStatus : undefined,
			plan,
			fetchedAt: typeof cache.fetchedAt === "string" && cache.fetchedAt.trim() ? cache.fetchedAt : undefined,
			message: typeof cache.message === "string" && cache.message.trim() ? cache.message.trim() : undefined,
			bankedResetCredits: banked.count,
			bankedResetExpirations: banked.expirations.length > 0 ? banked.expirations : undefined,
			windows: parseQuotaWindows(cache.quotas),
		};
	});

	entries.sort((a, b) => {
		if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
		return `${a.provider} ${a.name ?? ""}`.localeCompare(`${b.provider} ${b.name ?? ""}`);
	});

	return { entries, intervalMinutes, lastAutoSyncAt, denied, errors };
}

function formatAge(iso: string | undefined): string | undefined {
	if (!iso) return undefined;
	const elapsedMs = Date.now() - Date.parse(iso);
	if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return "just now";
	const minutes = Math.floor(elapsedMs / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}

function formatReset(iso: string): string {
	return `${iso.slice(0, 16).replace("T", " ")}Z`;
}

function windowLabel(provider: string, window: QuotaWindow): string {
	if (window.displayName) return window.displayName;
	if (provider === "codex") {
		if (window.key === "session") return "5h window";
		if (window.key === "weekly") return "weekly window";
		if (window.key.startsWith("spark")) return `spark ${window.key.replace(/^spark[-_]?/, "")}`;
	}
	if (window.key === "credits" || window.key === "credits_usd") return "credits";
	return window.key;
}

function isMoney(window: QuotaWindow): boolean {
	return Boolean(window.currency) || window.key === "credits" || window.key === "credits_usd";
}

function windowLine(provider: string, window: QuotaWindow): string {
	const label = windowLabel(provider, window);
	if (isMoney(window)) {
		const remaining = window.remaining ?? 0;
		if (window.unlimited || !(window.total && window.total > 0)) return `${label}  ${formatCost(remaining)} left (unlimited)`;
		const percent = window.remainingPercentage !== undefined ? ` (${Math.round(window.remainingPercentage)}% left)` : "";
		return `${label}  ${formatCost(remaining)} of ${formatCost(window.total)} left${percent}`;
	}
	const parts: string[] = [];
	if (window.unlimited) parts.push("unlimited");
	else if (window.remainingPercentage !== undefined) parts.push(`${Math.round(window.remainingPercentage)}% left`);
	if (window.total !== undefined && window.total > 0 && window.used !== undefined) parts.push(`${window.used}/${window.total} used`);
	if (window.remaining !== undefined && !window.unlimited) parts.push(`${window.remaining} left`);
	if (window.resetAt) parts.push(`resets ${formatReset(window.resetAt)}`);
	return `${label}  ${parts.join(" · ") || "no limit reported"}`;
}

function formatBankedExpiry(expirations: string[]): string {
	const shown = expirations.slice(0, 3).map((iso) => formatReset(iso));
	const more = expirations.length > shown.length ? ` (+${expirations.length - shown.length} more)` : "";
	return `expiring ${shown.join(", ")}${more}`;
}

export function formatUsageReport(report: UsageReport): string {
	const lines = ["OmniRoute usage"];
	lines.push(`Accounts   ${report.entries.filter((entry) => entry.isActive).length} active`);
	for (const entry of report.entries) {
		const age = formatAge(entry.fetchedAt);
		const stale = entry.fetchedAt && Date.now() - Date.parse(entry.fetchedAt) > report.intervalMinutes * 2 * 60_000;
		const status = entry.isActive ? "active" : "inactive";
		const details = [status, entry.plan, age ? `cached ${age}${stale ? ", stale" : ""}` : undefined].filter(Boolean);
		lines.push("", `${entry.provider}${entry.name ? ` · ${entry.name}` : ""} · ${details.join(" · ")}`);
		if (entry.message) lines.push(`  ⚠ ${entry.message}`);
		for (const window of entry.windows) lines.push(`  ${windowLine(entry.provider, window)}`);
		if (entry.bankedResetCredits || entry.bankedResetExpirations?.length) {
			const count = entry.bankedResetCredits ?? entry.bankedResetExpirations?.length ?? 0;
			const expiry = entry.bankedResetExpirations?.length ? ` · ${formatBankedExpiry(entry.bankedResetExpirations)}` : "";
			lines.push(`  banked resets  ${count}${expiry}`);
		}
		if (!entry.windows.length && !entry.message) lines.push("  no limits reported (unsupported provider or not synced yet)");
	}
	if (report.denied) {
		lines.push("", "Limits endpoints need a management-scoped key (manage/admin). Re-run /omni setup with such a key.");
	} else if (report.errors.length > 0) {
		lines.push("", `Some accounts unavailable: ${report.errors[0]}`);
	}
	if (report.lastAutoSyncAt) lines.push("", `Last gateway sync: ${formatAge(report.lastAutoSyncAt) ?? "unknown"} (every ${report.intervalMinutes}m)`);
	return lines.join("\n");
}
