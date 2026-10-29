import { describe, expect, it } from 'vitest';

import {
    DAY_SECONDS,
    advertiserUrl,
    buildAdRow,
    buildCheckRow,
    buildEndedAdRow,
    buildErrorRow,
    creativeUrl,
    daysBetween,
    domainSearchUrl,
    formatMix,
    isActiveNow,
    rankAdvertisers,
    toIsoDate,
} from '../src/derive.js';
import { parseSearchCreativesResponse } from '../src/parse.js';
import type { Creative, Target } from '../src/types.js';
import { FIXTURE_NOW, fixtureText } from './helpers.js';

const nike = parseSearchCreativesResponse(fixtureText('nike-com.json'));
const otp = parseSearchCreativesResponse(fixtureText('otpbank-hu.json'));
const NOW_SEC = Math.floor(FIXTURE_NOW.getTime() / 1000);
const ctx = { now: FIXTURE_NOW, activeWindowDays: 7, region: 'anywhere' };
const nikeTarget: Target = { kind: 'domain', value: 'nike.com' };

describe('helpers', () => {
    it('formats dates and day spans', () => {
        expect(toIsoDate(1793227937)).toBe('2026-10-28');
        expect(toIsoDate(null)).toBeNull();
        expect(toIsoDate(Number.NaN)).toBeNull();
        expect(daysBetween(0, DAY_SECONDS * 3 + 100)).toBe(3);
        expect(daysBetween(10, 5)).toBe(0);
    });

    it('decides activity against the window boundary', () => {
        expect(isActiveNow(NOW_SEC - 7 * DAY_SECONDS, FIXTURE_NOW, 7)).toBe(true);
        expect(isActiveNow(NOW_SEC - 7 * DAY_SECONDS - 1, FIXTURE_NOW, 7)).toBe(false);
        expect(isActiveNow(null, FIXTURE_NOW, 7)).toBe(false);
    });

    it('builds Transparency Center URLs', () => {
        expect(advertiserUrl('AR1', 'anywhere')).toBe('https://adstransparency.google.com/advertiser/AR1?region=anywhere');
        expect(creativeUrl('AR1', 'CR2', 'US')).toBe('https://adstransparency.google.com/advertiser/AR1/creative/CR2?region=US');
        expect(domainSearchUrl('nike.com', 'HU')).toBe('https://adstransparency.google.com/?region=HU&domain=nike.com');
    });

    it('ranks advertisers by creatives in the sample, ties by first appearance', () => {
        const ranked = rankAdvertisers(nike.creatives);
        expect(ranked[0]).toEqual({ advertiser_id: 'AR18378488041124659201', advertiser_name: 'Nike Retail BV', creatives_in_sample: 51 });
        expect(ranked[1]).toEqual({ advertiser_id: 'AR16735076323512287233', advertiser_name: 'Nike, Inc.', creatives_in_sample: 32 });
        expect(ranked).toHaveLength(8);
        expect(ranked.reduce((n, a) => n + a.creatives_in_sample, 0)).toBe(100);
    });

    it('counts formats', () => {
        expect(formatMix(nike.creatives)).toEqual({ text: 85, image: 10, video: 5, unknown: 0 });
        expect(formatMix([])).toEqual({ text: 0, image: 0, video: 0, unknown: 0 });
    });
});

describe('buildCheckRow', () => {
    it('derives the nike.com summary row from the live fixture', () => {
        const row = buildCheckRow(nikeTarget, { creatives: nike.creatives, adCountLow: nike.adCountLow, adCountHigh: nike.adCountHigh }, ctx, null);
        expect(row).toMatchObject({
            row_type: 'domain',
            domain: 'nike.com',
            target_type: 'domain',
            region: 'anywhere',
            checked_at: '2026-10-29T00:00:00.000Z',
            status: 'advertising',
            advertiser_id: 'AR18378488041124659201',
            advertiser_name: 'Nike Retail BV',
            ad_count_low: 50_000,
            ad_count_high: 60_000,
            is_advertising_now: true,
            last_seen: '2026-10-28',
            days_since_last_ad: 0,
            first_seen_in_sample: '2021-10-25',
            active_creatives_in_sample: 100,
            format_mix: { text: 85, image: 10, video: 5, unknown: 0 },
            sample_size: 100,
            transparency_url: 'https://adstransparency.google.com/advertiser/AR18378488041124659201?region=anywhere',
            change_tracking: null,
            error: null,
        });
        expect(row.additional_advertisers).toHaveLength(7);
        expect(row.additional_advertisers[0]!.advertiser_id).toBe('AR16735076323512287233');

        const expectedLongest = Math.max(...nike.creatives.map((c) => daysBetween(c.firstShown!, c.lastShown!)));
        expect(row.longest_running_days).toBe(expectedLongest);
        expect(expectedLongest).toBeGreaterThanOrEqual(1829);
        expect(nike.creatives.find((c) => c.creativeId === row.longest_running_creative_id)!.firstShown).toBe(1635145200);
    });

    it('marks an advertiser inactive when the window has passed', () => {
        const later = new Date(FIXTURE_NOW.getTime() + 30 * DAY_SECONDS * 1000);
        const row = buildCheckRow(nikeTarget, { creatives: otp.creatives, adCountLow: 1000, adCountHigh: 2000 }, { ...ctx, now: later }, null);
        expect(row.is_advertising_now).toBe(false);
        expect(row.active_creatives_in_sample).toBe(0);
        expect(row.days_since_last_ad).toBe(30);
        expect(row.status).toBe('advertising');
    });

    it('builds a no_ads_found row pointing at the domain search', () => {
        const row = buildCheckRow({ kind: 'domain', value: 'example.org' }, { creatives: [], adCountLow: null, adCountHigh: null }, { ...ctx, region: 'US' }, null);
        expect(row).toMatchObject({
            status: 'no_ads_found',
            advertiser_id: null,
            advertiser_name: null,
            additional_advertisers: [],
            ad_count_low: null,
            is_advertising_now: false,
            last_seen: null,
            days_since_last_ad: null,
            first_seen_in_sample: null,
            longest_running_days: null,
            longest_running_creative_id: null,
            active_creatives_in_sample: 0,
            sample_size: 0,
            transparency_url: 'https://adstransparency.google.com/?region=US&domain=example.org',
        });
    });

    it('handles advertiser-id targets', () => {
        const target: Target = { kind: 'advertiser', value: 'AR16735076323512287233' };
        const empty = buildCheckRow(target, { creatives: [], adCountLow: null, adCountHigh: null }, ctx, null);
        expect(empty.target_type).toBe('advertiser_id');
        expect(empty.domain).toBe('AR16735076323512287233');
        expect(empty.advertiser_id).toBe('AR16735076323512287233');
        expect(empty.transparency_url).toBe('https://adstransparency.google.com/advertiser/AR16735076323512287233?region=anywhere');
    });

    it('passes change tracking through', () => {
        const summary = { new_creatives: ['CR1'], ended_creatives: [], new_count: 1, ended_count: 0, previous_run_at: null };
        const row = buildCheckRow(nikeTarget, { creatives: nike.creatives, adCountLow: null, adCountHigh: null }, ctx, summary);
        expect(row.change_tracking).toBe(summary);
    });

    it('builds error rows that are never charged-looking', () => {
        const row = buildErrorRow(nikeTarget, ctx, 'blocked by Google after retries (http_429, HTTP 429)');
        expect(row).toMatchObject({ status: 'error', error: 'blocked by Google after retries (http_429, HTTP 429)', sample_size: 0, is_advertising_now: false, ad_count_low: null });
        expect(row.transparency_url).toBe('https://adstransparency.google.com/?region=anywhere&domain=nike.com');
    });
});

describe('ad rows', () => {
    const first = nike.creatives[0]!;

    it('builds an ad row from a creative', () => {
        const row = buildAdRow(first, nikeTarget, ctx, 'new');
        expect(row).toEqual({
            row_type: 'ad',
            creative_id: 'CR04579281658410172417',
            advertiser_id: 'AR16735076323512287233',
            advertiser_name: 'Nike, Inc.',
            domain: 'nike.com',
            format: 'TEXT',
            first_shown: '2023-11-17',
            last_shown: '2026-10-28',
            days_shown: daysBetween(1700190458, 1793227937),
            is_active_now: true,
            preview_url: 'https://tpc.googlesyndication.com/archive/simgad/13335954786324240689',
            preview_type: 'image',
            transparency_url: 'https://adstransparency.google.com/advertiser/AR16735076323512287233/creative/CR04579281658410172417?region=anywhere',
            region: 'anywhere',
            change_status: 'new',
            scraped_at: '2026-10-29T00:00:00.000Z',
        });
        expect(row.days_shown).toBe(1076);
    });

    it('falls back to the target domain when Google omits field 14 and null for advertiser targets', () => {
        const noDomain: Creative = { ...first, domain: null };
        expect(buildAdRow(noDomain, nikeTarget, ctx, null).domain).toBe('nike.com');
        expect(buildAdRow(noDomain, { kind: 'advertiser', value: 'AR1' }, ctx, null).domain).toBeNull();
        expect(buildAdRow(noDomain, nikeTarget, ctx, null).change_status).toBeNull();
    });

    it('reports inactive when the window has passed and null spans when dates are missing', () => {
        const later = { ...ctx, now: new Date(FIXTURE_NOW.getTime() + 10 * DAY_SECONDS * 1000) };
        expect(buildAdRow(first, nikeTarget, later, 'seen').is_active_now).toBe(false);
        expect(buildAdRow({ ...first, firstShown: null }, nikeTarget, ctx, null).days_shown).toBeNull();
    });

    it('builds ended rows from the stored snapshot', () => {
        const row = buildEndedAdRow('CR_GONE', { first_shown: '2026-01-01', last_shown: '2026-10-01', advertiser_id: 'AR1', advertiser_name: 'Acme', format: 'IMAGE', domain: 'acme.com' }, nikeTarget, ctx);
        expect(row).toMatchObject({
            row_type: 'ad',
            creative_id: 'CR_GONE',
            advertiser_id: 'AR1',
            advertiser_name: 'Acme',
            domain: 'acme.com',
            format: 'IMAGE',
            first_shown: '2026-01-01',
            last_shown: '2026-10-01',
            days_shown: 273,
            is_active_now: false,
            preview_url: null,
            preview_type: 'none',
            transparency_url: 'https://adstransparency.google.com/advertiser/AR1/creative/CR_GONE?region=anywhere',
            change_status: 'ended',
        });
        const minimal = buildEndedAdRow('CR_X', { first_shown: null, last_shown: null }, nikeTarget, ctx);
        expect(minimal).toMatchObject({ domain: 'nike.com', format: 'UNKNOWN', days_shown: null, transparency_url: null, advertiser_id: null });
    });
});
