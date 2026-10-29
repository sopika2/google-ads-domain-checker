import { describe, expect, it } from 'vitest';

import {
    FORMAT_BY_CODE,
    ParseError,
    formatFromCode,
    isSortedByLastShownDesc,
    parseCreative,
    parsePreview,
    parseSearchCreativesResponse,
} from '../src/parse.js';
import { fixtureText } from './helpers.js';

const nike = parseSearchCreativesResponse(fixtureText('nike-com.json'));
const nikePage2 = parseSearchCreativesResponse(fixtureText('nike-com-page2.json'));
const otp = parseSearchCreativesResponse(fixtureText('otpbank-hu.json'));
const noAds = parseSearchCreativesResponse(fixtureText('no-ads.json'));
const byAdvertiser = parseSearchCreativesResponse(fixtureText('advertiser-id-nike.json'));

function count<T>(items: T[], pred: (t: T) => boolean): number {
    return items.filter(pred).length;
}

describe('parseSearchCreativesResponse on live fixtures', () => {
    it('parses the nike.com first page', () => {
        expect(nike.creatives).toHaveLength(100);
        expect(nike.nextCursor).toBe('CgoAP7zmhEl6GxtXEhA/hKCX0qXIe0pdG1gAAAAAGgn8+GY5+Aq0iY0=');
        expect(nike.adCountLow).toBe(50_000);
        expect(nike.adCountHigh).toBe(60_000);
        expect(nike.creatives.every((c) => c.domain === 'nike.com')).toBe(true);
        expect(nike.creatives.every((c) => /^AR\d+$/.test(c.advertiserId))).toBe(true);
        expect(nike.creatives.every((c) => /^CR\d+$/.test(c.creativeId))).toBe(true);
        expect(new Set(nike.creatives.map((c) => c.creativeId)).size).toBe(100);
    });

    it('maps the first nike creative field by field', () => {
        const first = nike.creatives[0]!;
        expect(first).toMatchObject({
            advertiserId: 'AR16735076323512287233',
            advertiserName: 'Nike, Inc.',
            creativeId: 'CR04579281658410172417',
            formatCode: 1,
            format: 'TEXT',
            firstShown: 1700190458,
            lastShown: 1793227937,
            domain: 'nike.com',
            previewType: 'image',
            previewUrl: 'https://tpc.googlesyndication.com/archive/simgad/13335954786324240689',
            daysShownReported: 909,
            flag16: null,
        });
    });

    it('resolves the format enum: 1 = TEXT, 2 = IMAGE, 3 = VIDEO', () => {
        expect(FORMAT_BY_CODE).toEqual({ 1: 'TEXT', 2: 'IMAGE', 3: 'VIDEO' });
        // nike.com: 85 text (68 archived screenshots + 17 rendered), 10 image, 5 video
        expect(count(nike.creatives, (c) => c.format === 'TEXT')).toBe(85);
        expect(count(nike.creatives, (c) => c.format === 'IMAGE')).toBe(10);
        expect(count(nike.creatives, (c) => c.format === 'VIDEO')).toBe(5);
        expect(count(nike.creatives, (c) => c.format === 'UNKNOWN')).toBe(0);
        // otpbank.hu: 41 text, 46 image, 13 video
        expect(count(otp.creatives, (c) => c.format === 'TEXT')).toBe(41);
        expect(count(otp.creatives, (c) => c.format === 'IMAGE')).toBe(46);
        expect(count(otp.creatives, (c) => c.format === 'VIDEO')).toBe(13);
    });

    it('image-format creatives carry standard banner sizes while text creatives are fixed-width screenshots', () => {
        const dims = (html: string) => {
            const w = html.match(/width=\\?"?([\d.]+)/)?.[1];
            const h = html.match(/height=\\?"?([\d.]+)/)?.[1];
            return `${w}x${h}`;
        };
        const raw = JSON.parse(fixtureText('otpbank-hu.json')) as { 1: Array<Record<string, any>> };
        const imageDims = raw[1].filter((c) => c['4'] === 2 && c['3']?.['3']?.['2']).map((c) => dims(c['3']['3']['2']));
        expect(imageDims).toEqual(expect.arrayContaining(['300x250', '300x600']));
        const textWidths = raw[1]
            .filter((c) => c['4'] === 1 && c['3']?.['3']?.['2'])
            .map((c) => Number(dims(c['3']['3']['2']).split('x')[0]));
        expect(textWidths.every((w) => w >= 340 && w <= 400)).toBe(true);
    });

    it('classifies previews: archived images (simgad and 2mdn) vs rendered content.js', () => {
        expect(count(nike.creatives, (c) => c.previewType === 'image')).toBe(70);
        expect(count(nike.creatives, (c) => c.previewType === 'rendered')).toBe(30);
        expect(nike.creatives.filter((c) => c.previewType === 'rendered').every((c) => c.previewUrl?.startsWith('https://displayads-formats.googleusercontent.com/ads/preview/content.js?'))).toBe(true);
        const twoMdn = otp.creatives.find((c) => c.previewUrl?.includes('s0.2mdn.net'));
        expect(twoMdn).toBeDefined();
        expect(twoMdn!.previewType).toBe('image');
        expect(twoMdn!.format).toBe('IMAGE');
        expect(twoMdn!.flag16).toBe(true);
        expect(count(otp.creatives, (c) => c.flag16 === true)).toBe(22);
    });

    it('returns creatives ordered by lastShown descending on every page', () => {
        expect(isSortedByLastShownDesc(nike.creatives)).toBe(true);
        expect(isSortedByLastShownDesc(nikePage2.creatives)).toBe(true);
        expect(isSortedByLastShownDesc(otp.creatives)).toBe(true);
        expect(isSortedByLastShownDesc(byAdvertiser.creatives)).toBe(true);
        const page1Min = Math.min(...nike.creatives.map((c) => c.lastShown!));
        const page2Max = Math.max(...nikePage2.creatives.map((c) => c.lastShown!));
        expect(page2Max).toBeLessThanOrEqual(page1Min);
    });

    it('page 2 continues page 1 without overlap and with a new cursor', () => {
        const page1Ids = new Set(nike.creatives.map((c) => c.creativeId));
        expect(nikePage2.creatives).toHaveLength(100);
        expect(nikePage2.creatives.some((c) => page1Ids.has(c.creativeId))).toBe(false);
        expect(nikePage2.nextCursor).toBeTruthy();
        expect(nikePage2.nextCursor).not.toBe(nike.nextCursor);
        expect(nikePage2.adCountLow).toBe(50_000);
    });

    it('parses otpbank.hu with two advertisers and an ad-count range', () => {
        expect(otp.creatives).toHaveLength(100);
        expect(otp.adCountLow).toBe(1000);
        expect(otp.adCountHigh).toBe(2000);
        const advertisers = new Set(otp.creatives.map((c) => c.advertiserId));
        expect(advertisers.size).toBe(2);
        expect(otp.creatives.filter((c) => c.advertiserId === 'AR11071058893055459329')).toHaveLength(78);
        expect(otp.creatives[0]!.advertiserName).toBe('OTP Bank Nyrt.');
    });

    it('treats the empty object as a target with no ads', () => {
        expect(noAds).toEqual({ creatives: [], nextCursor: null, adCountLow: null, adCountHigh: null });
    });

    it('parses advertiser-id searches, which omit the domain field', () => {
        expect(byAdvertiser.creatives).toHaveLength(100);
        expect(byAdvertiser.creatives.every((c) => c.advertiserId === 'AR16735076323512287233')).toBe(true);
        expect(byAdvertiser.creatives.every((c) => c.domain === null)).toBe(true);
        expect(byAdvertiser.adCountLow).toBe(8000);
        expect(byAdvertiser.adCountHigh).toBe(9000);
        expect(byAdvertiser.nextCursor).toBeTruthy();
    });

    it('all fixture timestamps are plausible unix seconds within the archive window', () => {
        const all = [...nike.creatives, ...otp.creatives, ...byAdvertiser.creatives, ...nikePage2.creatives];
        const archiveStart = Date.UTC(2021, 0, 1) / 1000;
        const captured = Date.UTC(2026, 9, 29) / 1000;
        for (const c of all) {
            expect(c.firstShown).not.toBeNull();
            expect(c.lastShown).not.toBeNull();
            expect(c.firstShown!).toBeGreaterThanOrEqual(archiveStart);
            expect(c.lastShown!).toBeLessThanOrEqual(captured);
            expect(c.lastShown!).toBeGreaterThanOrEqual(c.firstShown!);
        }
    });
});

describe('parseSearchCreativesResponse robustness', () => {
    it('accepts an already-parsed object and strips an anti-XSSI prefix', () => {
        const text = fixtureText('nike-com.json');
        expect(parseSearchCreativesResponse(JSON.parse(text)).creatives).toHaveLength(100);
        expect(parseSearchCreativesResponse(`)]}'\n${text}`).creatives).toHaveLength(100);
    });

    it('throws ParseError on HTML, empty and non-object bodies', () => {
        expect(() => parseSearchCreativesResponse('<html><body>Our systems have detected unusual traffic</body></html>')).toThrow(ParseError);
        expect(() => parseSearchCreativesResponse('')).toThrow(ParseError);
        expect(() => parseSearchCreativesResponse('   ')).toThrow(ParseError);
        expect(() => parseSearchCreativesResponse('[1,2,3]')).toThrow(ParseError);
        expect(() => parseSearchCreativesResponse('{"1":"nope"}')).toThrow(ParseError);
    });

    it('skips creatives without ids and tolerates numeric timestamps', () => {
        const page = parseSearchCreativesResponse({
            1: [
                { 1: 'AR1', 2: 'CR1', 4: 2, 6: { 1: 1700000000 }, 7: 1700086400, 12: 'X', 14: 'x.com' },
                { 1: 'AR1' },
                { 2: 'CR2' },
                'garbage',
            ],
            2: '',
            4: '10',
            5: 'abc',
        });
        expect(page.creatives).toHaveLength(1);
        expect(page.creatives[0]).toMatchObject({ firstShown: 1700000000, lastShown: 1700086400, format: 'IMAGE', previewType: 'none', previewUrl: null });
        expect(page.nextCursor).toBeNull();
        expect(page.adCountLow).toBe(10);
        expect(page.adCountHigh).toBeNull();
    });

    it('parseCreative returns null for non-objects and missing ids', () => {
        expect(parseCreative(null)).toBeNull();
        expect(parseCreative({ 1: 'AR1' })).toBeNull();
        expect(parseCreative({ 1: 'AR1', 2: 'CR1' })).toMatchObject({ format: 'UNKNOWN', firstShown: null, lastShown: null, domain: null });
    });
});

describe('parsePreview and formatFromCode fallbacks', () => {
    it('detects YouTube references as video previews', () => {
        expect(parsePreview({ 2: { 1: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' } })).toEqual({
            type: 'video',
            url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        });
        expect(parsePreview({ 9: { 3: 'https://youtu.be/dQw4w9WgXcQ?si=abc' } }).type).toBe('video');
    });

    it('extracts the image src from the archived <img> tag', () => {
        expect(parsePreview({ 3: { 2: '<img src="https://tpc.googlesyndication.com/archive/simgad/1" height="1" width="2">' }, 5: true })).toEqual({
            type: 'image',
            url: 'https://tpc.googlesyndication.com/archive/simgad/1',
        });
    });

    it('surfaces an unknown shape through its first URL and otherwise reports none', () => {
        expect(parsePreview({ 7: { 1: 'https://example.com/x' } })).toEqual({ type: 'rendered', url: 'https://example.com/x' });
        expect(parsePreview({ 3: { 2: 'no image tag here' } })).toEqual({ type: 'image', url: null });
        expect(parsePreview(undefined)).toEqual({ type: 'none', url: null });
        expect(parsePreview('string')).toEqual({ type: 'none', url: null });
    });

    it('uses the preview only when the format code is missing or unknown', () => {
        expect(formatFromCode(1, { type: 'video', url: 'x' })).toBe('TEXT');
        expect(formatFromCode(null, { type: 'video', url: 'x' })).toBe('VIDEO');
        expect(formatFromCode(9, { type: 'image', url: 'https://s0.2mdn.net/a.jpg' })).toBe('IMAGE');
        // Archived simgad images are also used for text-ad screenshots, so they cannot decide the format.
        expect(formatFromCode(9, { type: 'image', url: 'https://tpc.googlesyndication.com/archive/simgad/1' })).toBe('UNKNOWN');
        expect(formatFromCode(null, { type: 'rendered', url: 'x' })).toBe('UNKNOWN');
    });
});
