/**
 * Run-to-run change detection. Pure: takes the previous snapshot and the current creatives,
 * returns new/ended ids and the snapshot to store next.
 *
 * Rules (conservative, because only the latest N creatives are sampled):
 *   new   = in the current sample, not in the previous snapshot (on the first run every creative is new).
 *   ended = in the previous snapshot, not in the current sample, AND its last-shown date is older than
 *           activeWindowDays. A creative that merely fell out of the sample while still recently shown is
 *           carried forward unchanged so it can be resolved on a later run.
 */

import type { ChangeTrackingSummary, Creative, DomainState, StoredCreative } from './types.js';
import { DAY_SECONDS, nowSeconds, toIsoDate } from './derive.js';

export interface DiffOptions {
    now: Date;
    activeWindowDays: number;
    region: string;
}

export interface EndedCreative {
    creativeId: string;
    stored: StoredCreative;
}

export interface DiffResult {
    newIds: string[];
    endedIds: string[];
    ended: EndedCreative[];
    /** Previous creatives neither seen now nor old enough to be called ended. */
    carriedForward: number;
    previousRunAt: string | null;
    /** True when a snapshot existed but was taken for another region; it was ignored (fresh baseline). */
    regionMismatch: boolean;
    nextState: DomainState;
    summary: ChangeTrackingSummary;
}

export function isDomainState(value: unknown): value is DomainState {
    if (value === null || typeof value !== 'object') return false;
    const v = value as Record<string, unknown>;
    return typeof v.run_at === 'string' && v.creatives !== null && typeof v.creatives === 'object' && !Array.isArray(v.creatives);
}

function storedLastShownSeconds(stored: StoredCreative): number | null {
    if (typeof stored.last_shown_ts === 'number' && Number.isFinite(stored.last_shown_ts)) return stored.last_shown_ts;
    if (stored.last_shown) {
        const parsed = Date.parse(stored.last_shown);
        if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
    }
    return null;
}

export function toStoredCreative(creative: Creative): StoredCreative {
    return {
        first_shown: toIsoDate(creative.firstShown),
        last_shown: toIsoDate(creative.lastShown),
        last_shown_ts: creative.lastShown,
        advertiser_id: creative.advertiserId,
        advertiser_name: creative.advertiserName,
        format: creative.format,
        domain: creative.domain,
    };
}

export function diffCreatives(previous: DomainState | null | undefined, current: Creative[], opts: DiffOptions): DiffResult {
    const stored = previous && isDomainState(previous) ? previous : null;
    // A snapshot from another region describes a different creative set; never diff across regions.
    const regionMismatch = !!stored && typeof stored.region === 'string' && stored.region !== opts.region;
    const prev = regionMismatch ? null : stored;
    const prevCreatives = prev?.creatives ?? {};
    const cutoff = nowSeconds(opts.now) - opts.activeWindowDays * DAY_SECONDS;

    const currentIds = new Set<string>();
    const nextCreatives: Record<string, StoredCreative> = {};
    const newIds: string[] = [];
    for (const c of current) {
        if (currentIds.has(c.creativeId)) continue;
        currentIds.add(c.creativeId);
        nextCreatives[c.creativeId] = toStoredCreative(c);
        if (!Object.hasOwn(prevCreatives, c.creativeId)) newIds.push(c.creativeId);
    }

    const ended: EndedCreative[] = [];
    let carriedForward = 0;
    for (const [id, stored] of Object.entries(prevCreatives)) {
        if (currentIds.has(id)) continue;
        if (!stored || typeof stored !== 'object') continue;
        const last = storedLastShownSeconds(stored);
        if (last !== null && last < cutoff) {
            ended.push({ creativeId: id, stored });
        } else {
            nextCreatives[id] = stored;
            carriedForward++;
        }
    }

    const endedIds = ended.map((e) => e.creativeId);
    return {
        newIds,
        endedIds,
        ended,
        carriedForward,
        previousRunAt: prev?.run_at ?? null,
        regionMismatch,
        nextState: {
            run_at: opts.now.toISOString(),
            region: opts.region,
            creatives: nextCreatives,
        },
        summary: {
            new_creatives: newIds,
            ended_creatives: endedIds,
            new_count: newIds.length,
            ended_count: endedIds.length,
            previous_run_at: prev?.run_at ?? null,
        },
    };
}
