/**
 * Pure parser for the numeric-field SearchCreatives response.
 *
 * Response layout (verified on live responses captured 2026-10-28, see test/fixtures/README.md):
 *   "1": array of creatives
 *       "1"  advertiser id (AR...)
 *       "2"  creative id (CR...)
 *       "3"  preview: {"3":{"2":"<img src=...>"}, "5":true} for archived images,
 *                     {"1":{"4":"https://displayads-formats.googleusercontent.com/ads/preview/content.js?..."}} for rendered previews
 *       "4"  format enum: 1 = TEXT, 2 = IMAGE, 3 = VIDEO
 *       "6"  {"1": unix seconds as string, "2": nanos} first shown
 *       "7"  {"1": unix seconds as string, "2": nanos} last shown
 *       "12" advertiser name
 *       "13" integer, tracks the number of days shown (inferred)
 *       "14" domain (absent when searching by advertiser id)
 *       "16" boolean, seen on agency-served creatives (meaning unknown)
 *   "2": next-page cursor (absent on the last page)
 *   "4", "5": approximate ad-count range as strings
 * A target with no ads returns "{}".
 */

import type { AdFormat, Creative, PreviewType, SearchPage } from './types.js';

export class ParseError extends Error {
    override name = 'ParseError';
}

const ANTI_XSSI_PREFIX = /^\)\]\}'\s*/;

/** Format enum resolved empirically: text ads are archived as fixed-width screenshots (field 4 = 1),
 * image banners carry standard IAB sizes such as 300x250 and 300x600 (field 4 = 2),
 * and video creatives render through the displayads-formats player (field 4 = 3). */
export const FORMAT_BY_CODE: Record<number, AdFormat> = {
    1: 'TEXT',
    2: 'IMAGE',
    3: 'VIDEO',
};

function asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

function asString(value: unknown): string | null {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return null;
}

function asInteger(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
    if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number.parseInt(value, 10);
    return null;
}

/** Field 6 / 7: {"1": "<unix seconds>", "2": <nanos>} -> unix seconds. */
function parseTimestamp(value: unknown): number | null {
    const rec = asRecord(value);
    if (!rec) return asInteger(value);
    const seconds = asInteger(rec['1']);
    if (seconds === null || seconds < 0) return null;
    return seconds;
}

/** Walk any nested structure and collect string leaves. */
function collectStrings(value: unknown, out: string[] = [], depth = 0): string[] {
    if (depth > 6) return out;
    if (typeof value === 'string') out.push(value);
    else if (Array.isArray(value)) for (const v of value) collectStrings(v, out, depth + 1);
    else {
        const rec = asRecord(value);
        if (rec) for (const v of Object.values(rec)) collectStrings(v, out, depth + 1);
    }
    return out;
}

const IMG_SRC_RE = /<img[^>]*\ssrc\s*=\s*["']([^"']+)["']/i;
const YOUTUBE_RE = /(?:https?:\/\/)?(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?v=|embed\/|v\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/;

export interface ParsedPreview {
    type: PreviewType;
    url: string | null;
}

/** Field 3 -> preview type and URL. */
export function parsePreview(field3: unknown): ParsedPreview {
    const rec = asRecord(field3);
    if (!rec) return { type: 'none', url: null };

    // 3.3.2 = archived image as an <img> tag (tpc.googlesyndication.com/archive/simgad/... or s0.2mdn.net/...).
    const imageHtml = asString(asRecord(rec['3'])?.['2']);
    if (imageHtml) {
        const src = imageHtml.match(IMG_SRC_RE)?.[1];
        if (src) return { type: 'image', url: src };
    }

    // 3.1.4 = rendered preview served by displayads-formats.googleusercontent.com.
    const rendered = asString(asRecord(rec['1'])?.['4']);

    // Any YouTube reference anywhere in the preview block means a video preview.
    for (const s of collectStrings(rec)) {
        const yt = s.match(YOUTUBE_RE);
        if (yt?.[1]) return { type: 'video', url: `https://www.youtube.com/watch?v=${yt[1]}` };
    }

    if (rendered) return { type: 'rendered', url: rendered };

    // Unknown shape: surface the first http(s) URL so nothing is silently lost.
    const anyUrl = collectStrings(rec).find((s) => /^https?:\/\//.test(s));
    if (anyUrl) return { type: 'rendered', url: anyUrl };
    if (imageHtml) return { type: 'image', url: null };
    return { type: 'none', url: null };
}

export function formatFromCode(code: number | null, preview: ParsedPreview): AdFormat {
    if (code !== null && FORMAT_BY_CODE[code]) return FORMAT_BY_CODE[code];
    // Preview-based fallback, only when field 4 is missing or carries an unknown value.
    if (preview.type === 'video') return 'VIDEO';
    if (preview.type === 'image' && preview.url && !/\/archive\/simgad\//.test(preview.url)) return 'IMAGE';
    return 'UNKNOWN';
}

/** Parse one creative object; returns null when the mandatory ids are missing. */
export function parseCreative(raw: unknown): Creative | null {
    const rec = asRecord(raw);
    if (!rec) return null;
    const advertiserId = asString(rec['1']);
    const creativeId = asString(rec['2']);
    if (!advertiserId || !creativeId) return null;

    const preview = parsePreview(rec['3']);
    const formatCode = asInteger(rec['4']);
    const flag16 = typeof rec['16'] === 'boolean' ? rec['16'] : null;

    return {
        advertiserId,
        advertiserName: asString(rec['12']),
        creativeId,
        formatCode,
        format: formatFromCode(formatCode, preview),
        firstShown: parseTimestamp(rec['6']),
        lastShown: parseTimestamp(rec['7']),
        domain: asString(rec['14']),
        previewType: preview.type,
        previewUrl: preview.url,
        daysShownReported: asInteger(rec['13']),
        flag16,
    };
}

/**
 * Parse a full SearchCreatives response body (string or already-parsed JSON).
 * Throws ParseError when the body is not JSON (for example an HTML block page).
 */
export function parseSearchCreativesResponse(body: unknown): SearchPage {
    let data: unknown = body;
    if (typeof body === 'string') {
        const text = body.replace(ANTI_XSSI_PREFIX, '').trim();
        if (!text) throw new ParseError('Empty response body');
        try {
            data = JSON.parse(text);
        } catch (err) {
            throw new ParseError(`Response is not JSON: ${(err as Error).message}; starts with ${JSON.stringify(text.slice(0, 80))}`);
        }
    }
    const rec = asRecord(data);
    if (!rec) throw new ParseError(`Unexpected response shape: ${Array.isArray(data) ? 'array' : typeof data}`);

    const rawList = rec['1'];
    const creatives: Creative[] = [];
    if (rawList !== undefined) {
        if (!Array.isArray(rawList)) throw new ParseError('Field 1 is not an array');
        for (const item of rawList) {
            const creative = parseCreative(item);
            if (creative) creatives.push(creative);
        }
    }

    const cursor = asString(rec['2']);
    return {
        creatives,
        nextCursor: cursor && cursor.length > 0 ? cursor : null,
        adCountLow: asInteger(rec['4']),
        adCountHigh: asInteger(rec['5']),
    };
}

/** True when the creatives are in non-increasing lastShown order (what Google returns today). */
export function isSortedByLastShownDesc(creatives: Creative[]): boolean {
    for (let i = 1; i < creatives.length; i++) {
        const prev = creatives[i - 1]?.lastShown ?? 0;
        const cur = creatives[i]?.lastShown ?? 0;
        if (cur > prev) return false;
    }
    return true;
}
