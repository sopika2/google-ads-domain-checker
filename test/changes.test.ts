import { describe, expect, it } from 'vitest';

import { diffCreatives, isDomainState, toStoredCreative } from '../src/changes.js';
import { DAY_SECONDS } from '../src/derive.js';
import type { Creative, DomainState } from '../src/types.js';
import { FIXTURE_NOW } from './helpers.js';

const NOW_SEC = Math.floor(FIXTURE_NOW.getTime() / 1000);

function creative(id: string, overrides: Partial<Creative> = {}): Creative {
    return {
        advertiserId: 'AR1',
        advertiserName: 'Acme',
        creativeId: id,
        formatCode: 1,
        format: 'TEXT',
        firstShown: NOW_SEC - 30 * DAY_SECONDS,
        lastShown: NOW_SEC - DAY_SECONDS,
        domain: 'acme.com',
        previewType: 'none',
        previewUrl: null,
        daysShownReported: null,
        flag16: null,
        ...overrides,
    };
}

const opts = { now: FIXTURE_NOW, activeWindowDays: 7, region: 'anywhere' };

describe('diffCreatives', () => {
    it('treats the first run as a baseline where every creative is new', () => {
        const result = diffCreatives(null, [creative('CR1'), creative('CR2')], opts);
        expect(result.newIds).toEqual(['CR1', 'CR2']);
        expect(result.endedIds).toEqual([]);
        expect(result.previousRunAt).toBeNull();
        expect(result.carriedForward).toBe(0);
        expect(result.summary).toEqual({
            new_creatives: ['CR1', 'CR2'],
            ended_creatives: [],
            new_count: 2,
            ended_count: 0,
            previous_run_at: null,
        });
        expect(result.nextState.run_at).toBe(FIXTURE_NOW.toISOString());
        expect(result.nextState.region).toBe('anywhere');
        expect(Object.keys(result.nextState.creatives)).toEqual(['CR1', 'CR2']);
        expect(result.nextState.creatives.CR1).toEqual({
            first_shown: '2026-09-29',
            last_shown: '2026-10-28',
            last_shown_ts: NOW_SEC - DAY_SECONDS,
            advertiser_id: 'AR1',
            advertiser_name: 'Acme',
            format: 'TEXT',
            domain: 'acme.com',
        });
    });

    it('labels new, seen, ended and carried-forward creatives on a later run', () => {
        const previous: DomainState = {
            run_at: '2026-10-20T00:00:00.000Z',
            region: 'anywhere',
            creatives: {
                CR_OLD_GONE: { first_shown: '2026-01-01', last_shown: '2026-10-10' }, // 19 days ago: ended
                CR_RECENT_GONE: { first_shown: '2026-10-01', last_shown: '2026-10-27' }, // 2 days ago: carried
                CR_STILL_HERE: { first_shown: '2026-10-01', last_shown: '2026-10-19' },
                CR_NO_DATE: { first_shown: null, last_shown: null }, // cannot decide: carried
            },
        };
        const current = [creative('CR_STILL_HERE'), creative('CR_NEW')];
        const result = diffCreatives(previous, current, opts);

        expect(result.newIds).toEqual(['CR_NEW']);
        expect(result.endedIds).toEqual(['CR_OLD_GONE']);
        expect(result.ended[0]!.stored.last_shown).toBe('2026-10-10');
        expect(result.carriedForward).toBe(2);
        expect(result.previousRunAt).toBe('2026-10-20T00:00:00.000Z');
        expect(Object.keys(result.nextState.creatives).sort()).toEqual(['CR_NEW', 'CR_NO_DATE', 'CR_RECENT_GONE', 'CR_STILL_HERE']);
        // Current data refreshes the stored record.
        expect(result.nextState.creatives.CR_STILL_HERE!.last_shown).toBe('2026-10-28');
        // Carried-forward records keep their old data.
        expect(result.nextState.creatives.CR_RECENT_GONE).toEqual({ first_shown: '2026-10-01', last_shown: '2026-10-27' });
    });

    it('uses the exact timestamp for the ended cutoff when available', () => {
        const justInside = NOW_SEC - 7 * DAY_SECONDS + 60;
        const justOutside = NOW_SEC - 7 * DAY_SECONDS - 60;
        const previous: DomainState = {
            run_at: '2026-10-20T00:00:00.000Z',
            region: 'anywhere',
            creatives: {
                INSIDE: { first_shown: '2026-10-01', last_shown: '2026-10-22', last_shown_ts: justInside },
                OUTSIDE: { first_shown: '2026-10-01', last_shown: '2026-10-21', last_shown_ts: justOutside },
            },
        };
        const result = diffCreatives(previous, [], opts);
        expect(result.endedIds).toEqual(['OUTSIDE']);
        expect(result.carriedForward).toBe(1);
    });

    it('falls back to a baseline when the stored value is malformed', () => {
        const result = diffCreatives({ bogus: true } as unknown as DomainState, [creative('CR1')], opts);
        expect(result.newIds).toEqual(['CR1']);
        expect(result.previousRunAt).toBeNull();
        expect(isDomainState({ run_at: 'x', creatives: {} })).toBe(true);
        expect(isDomainState({ run_at: 'x', creatives: [] })).toBe(false);
        expect(isDomainState(null)).toBe(false);
    });

    it('collapses duplicate creative ids in the current sample', () => {
        const result = diffCreatives(null, [creative('CR1'), creative('CR1', { lastShown: NOW_SEC })], opts);
        expect(result.newIds).toEqual(['CR1']);
        expect(Object.keys(result.nextState.creatives)).toEqual(['CR1']);
    });

    it('does not report an ended creative twice across runs', () => {
        const previous: DomainState = {
            run_at: '2026-10-20T00:00:00.000Z',
            region: 'anywhere',
            creatives: { GONE: { first_shown: '2026-01-01', last_shown: '2026-10-01' } },
        };
        const first = diffCreatives(previous, [], opts);
        expect(first.endedIds).toEqual(['GONE']);
        const second = diffCreatives(first.nextState, [], { ...opts, now: new Date(FIXTURE_NOW.getTime() + DAY_SECONDS * 1000) });
        expect(second.endedIds).toEqual([]);
    });

    it('toStoredCreative keeps the fields needed for ended rows', () => {
        expect(toStoredCreative(creative('CR9', { format: 'VIDEO', domain: null }))).toMatchObject({ format: 'VIDEO', domain: null, advertiser_id: 'AR1' });
    });
});
