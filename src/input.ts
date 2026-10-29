/**
 * Input resolution: defaults, clamping and target normalisation. Pure, no Apify dependency.
 */

import { normalizeAdvertiserIds, normalizeDomains } from './normalize.js';
import { resolveRegion, type ResolvedRegion } from './regions.js';
import type { ActorInput, Mode, Target } from './types.js';

export const TARGET_SOFT_CAP = 10_000;

export const DEFAULTS = {
    mode: 'check' as Mode,
    region: 'anywhere',
    sampleSize: 100,
    maxAdsPerDomain: 500,
    activeWindowDays: 7,
    trackChanges: false,
    stateStoreName: 'google-ads-domain-check-state',
    requestDelayMs: 1000,
    maxConcurrency: 4,
} as const;

export const LIMITS = {
    sampleSize: [20, 500],
    maxAdsPerDomain: [1, 5000],
    activeWindowDays: [1, 400],
    requestDelayMs: [250, 10_000],
    maxConcurrency: [1, 8],
} as const;

/** Apify named-storage rule: 3-63 letters, digits or hyphens, not starting or ending with a hyphen. */
export const STATE_STORE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9-]{1,61}[a-zA-Z0-9]$/;

export function clampInt(value: unknown, fallback: number, [min, max]: readonly [number, number]): number {
    const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.trunc(n)));
}

export interface ResolvedInput {
    mode: Mode;
    region: ResolvedRegion;
    sampleSize: number;
    maxAdsPerDomain: number;
    activeWindowDays: number;
    trackChanges: boolean;
    stateStoreName: string;
    requestDelayMs: number;
    maxConcurrency: number;
    targets: Target[];
    invalidInputs: string[];
    truncatedTargets: number;
}

export interface FetchPlan {
    /** How many creatives to fetch per target (100 per request). */
    maxCreatives: number;
    /** How many of them become ad rows (0 in check mode). */
    adRowLimit: number;
}

/**
 * check: read sampleSize creatives, emit none as ad rows.
 * ads: read and emit up to maxAdsPerDomain.
 * both: read enough for both, emit up to maxAdsPerDomain as ad rows and derive the check row from the first sampleSize.
 */
export function planFetch(input: Pick<ResolvedInput, 'mode' | 'sampleSize' | 'maxAdsPerDomain'>): FetchPlan {
    switch (input.mode) {
        case 'check':
            return { maxCreatives: input.sampleSize, adRowLimit: 0 };
        case 'ads':
            return { maxCreatives: input.maxAdsPerDomain, adRowLimit: input.maxAdsPerDomain };
        case 'both':
            return { maxCreatives: Math.max(input.sampleSize, input.maxAdsPerDomain), adRowLimit: input.maxAdsPerDomain };
    }
}

/** Apply defaults and limits; throws only for an unknown region. */
export function resolveInput(input: ActorInput | null | undefined): ResolvedInput {
    const raw = input ?? {};
    const mode = (['check', 'ads', 'both'] as const).includes(raw.mode as Mode) ? (raw.mode as Mode) : DEFAULTS.mode;
    const region = resolveRegion(raw.region ?? DEFAULTS.region);

    const domains = normalizeDomains(raw.domains);
    const advertisers = normalizeAdvertiserIds(raw.advertiserIds);
    let targets: Target[] = [
        ...domains.values.map((value): Target => ({ kind: 'domain', value })),
        ...advertisers.values.map((value): Target => ({ kind: 'advertiser', value })),
    ];
    let truncatedTargets = 0;
    if (targets.length > TARGET_SOFT_CAP) {
        truncatedTargets = targets.length - TARGET_SOFT_CAP;
        targets = targets.slice(0, TARGET_SOFT_CAP);
    }

    const stateStoreName =
        typeof raw.stateStoreName === 'string' && STATE_STORE_NAME_RE.test(raw.stateStoreName)
            ? raw.stateStoreName
            : DEFAULTS.stateStoreName;

    return {
        mode,
        region,
        sampleSize: clampInt(raw.sampleSize, DEFAULTS.sampleSize, LIMITS.sampleSize),
        maxAdsPerDomain: clampInt(raw.maxAdsPerDomain, DEFAULTS.maxAdsPerDomain, LIMITS.maxAdsPerDomain),
        activeWindowDays: clampInt(raw.activeWindowDays, DEFAULTS.activeWindowDays, LIMITS.activeWindowDays),
        trackChanges: raw.trackChanges === true,
        stateStoreName,
        requestDelayMs: clampInt(raw.requestDelayMs, DEFAULTS.requestDelayMs, LIMITS.requestDelayMs),
        maxConcurrency: clampInt(raw.maxConcurrency, DEFAULTS.maxConcurrency, LIMITS.maxConcurrency),
        targets,
        invalidInputs: [...domains.invalid, ...advertisers.invalid],
        truncatedTargets,
    };
}
