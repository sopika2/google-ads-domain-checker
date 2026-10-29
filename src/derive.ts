/**
 * Pure derivations from parsed creatives to dataset rows.
 */

import type {
    AdRow,
    AdvertiserSummary,
    ChangeStatus,
    ChangeTrackingSummary,
    CheckRow,
    Creative,
    FormatMix,
    StoredCreative,
    Target,
} from './types.js';

export const DAY_SECONDS = 86_400;
export const ATC_BASE = 'https://adstransparency.google.com';

export interface DeriveContext {
    now: Date;
    activeWindowDays: number;
    /** "anywhere" or upper-case alpha-2. */
    region: string;
}

export function toIsoDate(unixSeconds: number | null | undefined): string | null {
    if (unixSeconds === null || unixSeconds === undefined || !Number.isFinite(unixSeconds)) return null;
    return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

/** Whole days from one unix timestamp to another, never negative. */
export function daysBetween(fromSeconds: number, toSeconds: number): number {
    return Math.max(0, Math.floor((toSeconds - fromSeconds) / DAY_SECONDS));
}

export function nowSeconds(now: Date): number {
    return Math.floor(now.getTime() / 1000);
}

export function isActiveNow(lastShown: number | null, now: Date, activeWindowDays: number): boolean {
    if (lastShown === null) return false;
    return lastShown >= nowSeconds(now) - activeWindowDays * DAY_SECONDS;
}

export function advertiserUrl(advertiserId: string, region: string): string {
    return `${ATC_BASE}/advertiser/${encodeURIComponent(advertiserId)}?region=${encodeURIComponent(region)}`;
}

export function creativeUrl(advertiserId: string, creativeId: string, region: string): string {
    return `${ATC_BASE}/advertiser/${encodeURIComponent(advertiserId)}/creative/${encodeURIComponent(creativeId)}?region=${encodeURIComponent(region)}`;
}

export function domainSearchUrl(domain: string, region: string): string {
    return `${ATC_BASE}/?region=${encodeURIComponent(region)}&domain=${encodeURIComponent(domain)}`;
}

/** What goes into the `domain` column for a target. */
export function targetLabel(target: Target): string {
    return target.value;
}

export function formatMix(creatives: Creative[]): FormatMix {
    const mix: FormatMix = { text: 0, image: 0, video: 0, unknown: 0 };
    for (const c of creatives) {
        if (c.format === 'TEXT') mix.text++;
        else if (c.format === 'IMAGE') mix.image++;
        else if (c.format === 'VIDEO') mix.video++;
        else mix.unknown++;
    }
    return mix;
}

/** Advertisers in the sample, most creatives first; ties keep first-seen order. */
export function rankAdvertisers(creatives: Creative[]): AdvertiserSummary[] {
    const byId = new Map<string, AdvertiserSummary>();
    for (const c of creatives) {
        const existing = byId.get(c.advertiserId);
        if (existing) {
            existing.creatives_in_sample++;
            if (!existing.advertiser_name && c.advertiserName) existing.advertiser_name = c.advertiserName;
        } else {
            byId.set(c.advertiserId, {
                advertiser_id: c.advertiserId,
                advertiser_name: c.advertiserName,
                creatives_in_sample: 1,
            });
        }
    }
    // Stable sort: Array.prototype.sort is stable in modern V8, so ties keep insertion order.
    return [...byId.values()].sort((a, b) => b.creatives_in_sample - a.creatives_in_sample);
}

export interface TargetData {
    creatives: Creative[];
    adCountLow: number | null;
    adCountHigh: number | null;
}

export function buildCheckRow(
    target: Target,
    data: TargetData,
    ctx: DeriveContext,
    changes: ChangeTrackingSummary | null = null,
): CheckRow {
    const { creatives } = data;
    const advertisers = rankAdvertisers(creatives);
    const primary = advertisers[0] ?? null;

    let maxLast: number | null = null;
    let minFirst: number | null = null;
    let longestDays: number | null = null;
    let longestId: string | null = null;
    let active = 0;
    for (const c of creatives) {
        if (c.lastShown !== null && (maxLast === null || c.lastShown > maxLast)) maxLast = c.lastShown;
        if (c.firstShown !== null && (minFirst === null || c.firstShown < minFirst)) minFirst = c.firstShown;
        if (c.firstShown !== null && c.lastShown !== null) {
            const days = daysBetween(c.firstShown, c.lastShown);
            if (longestDays === null || days > longestDays) {
                longestDays = days;
                longestId = c.creativeId;
            }
        }
        if (isActiveNow(c.lastShown, ctx.now, ctx.activeWindowDays)) active++;
    }

    const hasAds = creatives.length > 0;
    const label = targetLabel(target);
    const transparencyUrl = primary
        ? advertiserUrl(primary.advertiser_id, ctx.region)
        : target.kind === 'domain'
          ? domainSearchUrl(label, ctx.region)
          : advertiserUrl(target.value, ctx.region);

    return {
        row_type: 'domain',
        domain: label,
        target_type: target.kind === 'domain' ? 'domain' : 'advertiser_id',
        region: ctx.region,
        checked_at: ctx.now.toISOString(),
        status: hasAds ? 'advertising' : 'no_ads_found',
        advertiser_id: primary?.advertiser_id ?? (target.kind === 'advertiser' ? target.value : null),
        advertiser_name: primary?.advertiser_name ?? null,
        additional_advertisers: advertisers.slice(1),
        ad_count_low: data.adCountLow,
        ad_count_high: data.adCountHigh,
        is_advertising_now: active > 0,
        last_seen: toIsoDate(maxLast),
        days_since_last_ad: maxLast === null ? null : daysBetween(maxLast, nowSeconds(ctx.now)),
        first_seen_in_sample: toIsoDate(minFirst),
        longest_running_days: longestDays,
        longest_running_creative_id: longestId,
        active_creatives_in_sample: active,
        format_mix: formatMix(creatives),
        sample_size: creatives.length,
        transparency_url: transparencyUrl,
        change_tracking: changes,
        error: null,
    };
}

export function buildErrorRow(target: Target, ctx: DeriveContext, error: string): CheckRow {
    const label = targetLabel(target);
    return {
        row_type: 'domain',
        domain: label,
        target_type: target.kind === 'domain' ? 'domain' : 'advertiser_id',
        region: ctx.region,
        checked_at: ctx.now.toISOString(),
        status: 'error',
        advertiser_id: target.kind === 'advertiser' ? target.value : null,
        advertiser_name: null,
        additional_advertisers: [],
        ad_count_low: null,
        ad_count_high: null,
        is_advertising_now: false,
        last_seen: null,
        days_since_last_ad: null,
        first_seen_in_sample: null,
        longest_running_days: null,
        longest_running_creative_id: null,
        active_creatives_in_sample: 0,
        format_mix: { text: 0, image: 0, video: 0, unknown: 0 },
        sample_size: 0,
        transparency_url: target.kind === 'domain' ? domainSearchUrl(label, ctx.region) : advertiserUrl(target.value, ctx.region),
        change_tracking: null,
        error,
    };
}

export function buildAdRow(
    creative: Creative,
    target: Target,
    ctx: DeriveContext,
    changeStatus: ChangeStatus | null,
): AdRow {
    return {
        row_type: 'ad',
        creative_id: creative.creativeId,
        advertiser_id: creative.advertiserId,
        advertiser_name: creative.advertiserName,
        domain: creative.domain ?? (target.kind === 'domain' ? target.value : null),
        format: creative.format,
        first_shown: toIsoDate(creative.firstShown),
        last_shown: toIsoDate(creative.lastShown),
        days_shown:
            creative.firstShown !== null && creative.lastShown !== null
                ? daysBetween(creative.firstShown, creative.lastShown)
                : null,
        is_active_now: isActiveNow(creative.lastShown, ctx.now, ctx.activeWindowDays),
        preview_url: creative.previewUrl,
        preview_type: creative.previewType,
        transparency_url: creativeUrl(creative.advertiserId, creative.creativeId, ctx.region),
        region: ctx.region,
        change_status: changeStatus,
        scraped_at: ctx.now.toISOString(),
    };
}

/** Row for a creative that was in the previous snapshot and is now considered ended. */
export function buildEndedAdRow(creativeId: string, stored: StoredCreative, target: Target, ctx: DeriveContext): AdRow {
    const first = stored.first_shown ? Math.floor(Date.parse(stored.first_shown) / 1000) : null;
    const last = stored.last_shown ? Math.floor(Date.parse(stored.last_shown) / 1000) : null;
    const advertiserId = stored.advertiser_id ?? (target.kind === 'advertiser' ? target.value : null);
    return {
        row_type: 'ad',
        creative_id: creativeId,
        advertiser_id: advertiserId,
        advertiser_name: stored.advertiser_name ?? null,
        domain: stored.domain ?? (target.kind === 'domain' ? target.value : null),
        format: stored.format ?? 'UNKNOWN',
        first_shown: stored.first_shown ?? null,
        last_shown: stored.last_shown ?? null,
        days_shown: first !== null && last !== null && Number.isFinite(first) && Number.isFinite(last) ? daysBetween(first, last) : null,
        is_active_now: false,
        preview_url: null,
        preview_type: 'none',
        transparency_url: advertiserId ? creativeUrl(advertiserId, creativeId, ctx.region) : null,
        region: ctx.region,
        change_status: 'ended',
        scraped_at: ctx.now.toISOString(),
    };
}
