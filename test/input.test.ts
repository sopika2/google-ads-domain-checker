import { describe, expect, it } from 'vitest';

import { DEFAULTS, LIMITS, TARGET_SOFT_CAP, clampInt, planFetch, resolveInput } from '../src/input.js';

describe('planFetch', () => {
    it('reads only the sample in check mode and emits no ad rows', () => {
        expect(planFetch({ mode: 'check', sampleSize: 100, maxAdsPerDomain: 500 })).toEqual({ maxCreatives: 100, adRowLimit: 0 });
    });

    it('ignores sampleSize in ads mode (regression: maxAdsPerDomain 20 must not fetch 100)', () => {
        expect(planFetch({ mode: 'ads', sampleSize: 100, maxAdsPerDomain: 20 })).toEqual({ maxCreatives: 20, adRowLimit: 20 });
        expect(planFetch({ mode: 'ads', sampleSize: 20, maxAdsPerDomain: 500 })).toEqual({ maxCreatives: 500, adRowLimit: 500 });
    });

    it('fetches enough for both row types in both mode', () => {
        expect(planFetch({ mode: 'both', sampleSize: 100, maxAdsPerDomain: 20 })).toEqual({ maxCreatives: 100, adRowLimit: 20 });
        expect(planFetch({ mode: 'both', sampleSize: 20, maxAdsPerDomain: 120 })).toEqual({ maxCreatives: 120, adRowLimit: 120 });
    });
});

describe('resolveInput', () => {
    it('applies defaults to an empty input', () => {
        const r = resolveInput({});
        expect(r).toMatchObject({
            mode: 'check',
            region: { label: 'anywhere', code: null },
            sampleSize: 100,
            maxAdsPerDomain: 500,
            activeWindowDays: 7,
            trackChanges: false,
            stateStoreName: DEFAULTS.stateStoreName,
            requestDelayMs: 1000,
            maxConcurrency: 4,
            targets: [],
            invalidInputs: [],
            truncatedTargets: 0,
        });
        expect(resolveInput(null).targets).toEqual([]);
        expect(resolveInput(undefined).mode).toBe('check');
    });

    it('normalises and dedupes domains and advertiser ids into targets', () => {
        const r = resolveInput({
            domains: ['https://www.Nike.com/x', 'nike.com', 'bad domain', 'otpbank.hu'],
            advertiserIds: ['ar16735076323512287233', 'junk', 'AR16735076323512287233'],
        });
        expect(r.targets).toEqual([
            { kind: 'domain', value: 'nike.com' },
            { kind: 'domain', value: 'otpbank.hu' },
            { kind: 'advertiser', value: 'AR16735076323512287233' },
        ]);
        expect(r.invalidInputs).toEqual(['bad domain', 'junk']);
    });

    it('clamps numbers into the schema ranges and falls back on junk', () => {
        const r = resolveInput({ sampleSize: 5, maxAdsPerDomain: 99_999, activeWindowDays: 0, requestDelayMs: 10, maxConcurrency: 50 });
        expect(r.sampleSize).toBe(LIMITS.sampleSize[0]);
        expect(r.maxAdsPerDomain).toBe(LIMITS.maxAdsPerDomain[1]);
        expect(r.activeWindowDays).toBe(LIMITS.activeWindowDays[0]);
        expect(r.requestDelayMs).toBe(LIMITS.requestDelayMs[0]);
        expect(r.maxConcurrency).toBe(LIMITS.maxConcurrency[1]);
        expect(resolveInput({ sampleSize: 'abc' as unknown as number }).sampleSize).toBe(100);
        expect(resolveInput({ sampleSize: '250' as unknown as number }).sampleSize).toBe(250);
        expect(clampInt(3.9, 1, [1, 10])).toBe(3);
        expect(clampInt(undefined, 7, [1, 10])).toBe(7);
    });

    it('resolves regions and rejects unknown ones', () => {
        expect(resolveInput({ region: 'us' }).region).toEqual({ label: 'US', code: 2840 });
        expect(resolveInput({ region: 'anywhere' }).region).toEqual({ label: 'anywhere', code: null });
        expect(() => resolveInput({ region: 'Narnia' })).toThrow(/Unknown region/);
    });

    it('validates mode, trackChanges and the state store name', () => {
        expect(resolveInput({ mode: 'ads' }).mode).toBe('ads');
        expect(resolveInput({ mode: 'both' }).mode).toBe('both');
        expect(resolveInput({ mode: 'everything' as 'check' }).mode).toBe('check');
        expect(resolveInput({ trackChanges: 'yes' as unknown as boolean }).trackChanges).toBe(false);
        expect(resolveInput({ trackChanges: true }).trackChanges).toBe(true);
        expect(resolveInput({ stateStoreName: 'my-list-2026' }).stateStoreName).toBe('my-list-2026');
        expect(resolveInput({ stateStoreName: 'has spaces!' }).stateStoreName).toBe(DEFAULTS.stateStoreName);
        expect(resolveInput({ stateStoreName: 'ab' }).stateStoreName).toBe(DEFAULTS.stateStoreName);
    });

    it('applies the soft cap of 10,000 targets', () => {
        const domains = Array.from({ length: TARGET_SOFT_CAP + 5 }, (_, i) => `d${i}.example`);
        const r = resolveInput({ domains });
        expect(r.targets).toHaveLength(TARGET_SOFT_CAP);
        expect(r.truncatedTargets).toBe(5);
        expect(r.targets[0]).toEqual({ kind: 'domain', value: 'd0.example' });
    });
});
