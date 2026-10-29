import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

import { ISO_NUMERIC_BY_ALPHA2, REGION_COUNT } from '../src/regions-data.js';
import { ANYWHERE, ATC_REGION_OFFSET, regionCodeFor, resolveRegion, supportedRegions } from '../src/regions.js';

const require = createRequire(import.meta.url);
const countries = require('i18n-iso-countries') as {
    alpha2ToNumeric(code: string): string | undefined;
    getNumericCodes(): Record<string, string>;
};

describe('region table', () => {
    it('matches the spec examples', () => {
        expect(regionCodeFor('US')).toBe(2840);
        expect(regionCodeFor('hu')).toBe(2348);
        expect(regionCodeFor('DE')).toBe(2276);
        expect(regionCodeFor('GB')).toBe(2826);
        expect(regionCodeFor('FR')).toBe(2250);
        expect(regionCodeFor(' jp ')).toBe(2392);
        expect(regionCodeFor('ZZ')).toBeUndefined();
        expect(ATC_REGION_OFFSET).toBe(2000);
    });

    it('covers every ISO 3166-1 country and agrees with i18n-iso-countries', () => {
        expect(REGION_COUNT).toBeGreaterThanOrEqual(249);
        expect(Object.keys(ISO_NUMERIC_BY_ALPHA2)).toHaveLength(REGION_COUNT);
        for (const [alpha2, numeric] of Object.entries(ISO_NUMERIC_BY_ALPHA2)) {
            expect(alpha2).toMatch(/^[A-Z]{2}$/);
            expect(Number.parseInt(countries.alpha2ToNumeric(alpha2)!, 10)).toBe(numeric);
        }
        for (const alpha2 of Object.values(countries.getNumericCodes())) {
            expect(ISO_NUMERIC_BY_ALPHA2[alpha2]).toBeDefined();
        }
        expect(supportedRegions()).toContain('US');
        expect(supportedRegions()).toEqual([...supportedRegions()].sort());
    });
});

describe('resolveRegion', () => {
    it('defaults to anywhere', () => {
        expect(resolveRegion(undefined)).toEqual({ label: ANYWHERE, code: null });
        expect(resolveRegion(null)).toEqual({ label: ANYWHERE, code: null });
        expect(resolveRegion('')).toEqual({ label: ANYWHERE, code: null });
        expect(resolveRegion('Anywhere')).toEqual({ label: ANYWHERE, code: null });
        expect(resolveRegion('ALL')).toEqual({ label: ANYWHERE, code: null });
    });

    it('resolves alpha-2 codes case-insensitively', () => {
        expect(resolveRegion('us')).toEqual({ label: 'US', code: 2840 });
        expect(resolveRegion(' Hu ')).toEqual({ label: 'HU', code: 2348 });
    });

    it('rejects unknown values with a helpful message', () => {
        expect(() => resolveRegion('ZZ')).toThrow(/Unknown region "ZZ"/);
        expect(() => resolveRegion('USA')).toThrow(/alpha-2/);
        expect(() => resolveRegion(840)).toThrow(/must be a string/);
    });
});
