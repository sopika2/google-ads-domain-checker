import { describe, expect, it } from 'vitest';

import { normalizeAdvertiserId, normalizeAdvertiserIds, normalizeDomain, normalizeDomains } from '../src/normalize.js';

describe('normalizeDomain', () => {
    it.each([
        ['nike.com', 'nike.com'],
        ['  nike.com  ', 'nike.com'],
        ['NIKE.COM', 'nike.com'],
        ['www.nike.com', 'nike.com'],
        ['WWW.OTPBANK.HU.', 'otpbank.hu'],
        ['https://www.Nike.com/en/shoes?x=1#frag', 'nike.com'],
        ['http://nike.com/', 'nike.com'],
        ['nike.com/en/path', 'nike.com'],
        ['https://user:pw@example.com:8443/path', 'example.com'],
        ['example.com:8080', 'example.com'],
        ['www2.example.com', 'www2.example.com'],
        ['sub.www.example.com', 'sub.www.example.com'],
        ['münchen.de', 'xn--mnchen-3ya.de'],
        ['"nike.com"', 'nike.com'],
        ['<https://nike.com>', 'nike.com'],
        ['(nike.com)', 'nike.com'],
        ['localhost', 'localhost'],
        ['192.168.0.1', '192.168.0.1'],
        ['ftp://files.example.org/x', 'files.example.org'],
    ])('%s -> %s', (input, expected) => {
        expect(normalizeDomain(input)).toBe(expected);
    });

    it.each([
        '',
        '   ',
        'not a domain',
        'https://',
        'http://[::1]/',
        'nike.com,adidas.com',
        '-bad.com',
        'bad-.com',
        'a..b',
        'under_score.com',
    ])('rejects %j', (input) => {
        expect(normalizeDomain(input)).toBeNull();
    });

    it('rejects non-strings', () => {
        expect(normalizeDomain(42)).toBeNull();
        expect(normalizeDomain(null)).toBeNull();
        expect(normalizeDomain({})).toBeNull();
    });
});

describe('normalizeDomains', () => {
    it('dedupes after normalisation, preserves first-seen order and lists invalid entries', () => {
        const result = normalizeDomains(['https://www.nike.com/', 'Adidas.com', 'nike.com', 'not valid!', '', 'ADIDAS.COM/shop', 7]);
        expect(result.values).toEqual(['nike.com', 'adidas.com']);
        expect(result.invalid).toEqual(['not valid!']);
    });

    it('returns empty lists for non-arrays', () => {
        expect(normalizeDomains(undefined)).toEqual({ values: [], invalid: [] });
        expect(normalizeDomains('nike.com')).toEqual({ values: [], invalid: [] });
    });
});

describe('normalizeAdvertiserId(s)', () => {
    it('accepts ids in any case and pasted Transparency Center URLs', () => {
        expect(normalizeAdvertiserId('AR16735076323512287233')).toBe('AR16735076323512287233');
        expect(normalizeAdvertiserId('  ar16735076323512287233 ')).toBe('AR16735076323512287233');
        expect(normalizeAdvertiserId('https://adstransparency.google.com/advertiser/AR16735076323512287233?region=US')).toBe('AR16735076323512287233');
        expect(normalizeAdvertiserId('https://adstransparency.google.com/advertiser/AR16735076323512287233/creative/CR1?region=anywhere')).toBe('AR16735076323512287233');
    });

    it('rejects creative ids, short ids and junk', () => {
        expect(normalizeAdvertiserId('CR04579281658410172417')).toBeNull();
        expect(normalizeAdvertiserId('AR123')).toBeNull();
        expect(normalizeAdvertiserId('nike.com')).toBeNull();
        expect(normalizeAdvertiserId(123)).toBeNull();
    });

    it('dedupes and reports invalid entries', () => {
        const result = normalizeAdvertiserIds(['AR16735076323512287233', 'ar16735076323512287233', 'bogus', '']);
        expect(result.values).toEqual(['AR16735076323512287233']);
        expect(result.invalid).toEqual(['bogus']);
    });
});
