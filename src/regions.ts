/**
 * Region handling. The Ads Transparency Center identifies a country by 2000 + its ISO 3166-1 numeric code
 * (US = 2840, HU = 2348, DE = 2276, GB = 2826, FR = 2250). "anywhere" means: omit the region field.
 */

import { ISO_NUMERIC_BY_ALPHA2 } from './regions-data.js';

export const ANYWHERE = 'anywhere';
export const ATC_REGION_OFFSET = 2000;

export interface ResolvedRegion {
    /** "anywhere" or an upper-case alpha-2 code; used in output rows and Transparency Center URLs. */
    label: string;
    /** Value for the request's "8" field, or null when the region field must be omitted. */
    code: number | null;
}

/** Numeric Transparency Center region id for an alpha-2 code, or undefined when unknown. */
export function regionCodeFor(alpha2: string): number | undefined {
    const numeric = ISO_NUMERIC_BY_ALPHA2[alpha2.trim().toUpperCase()];
    return numeric === undefined ? undefined : ATC_REGION_OFFSET + numeric;
}

/** All alpha-2 codes the actor accepts, sorted. */
export function supportedRegions(): string[] {
    return Object.keys(ISO_NUMERIC_BY_ALPHA2).sort();
}

const ANYWHERE_ALIASES = new Set(['', 'anywhere', 'all', 'global', 'worldwide', 'any']);

/** Resolve the `region` input. Throws a descriptive error for unknown values. */
export function resolveRegion(input: unknown): ResolvedRegion {
    if (input === undefined || input === null) return { label: ANYWHERE, code: null };
    if (typeof input !== 'string') throw new Error(`region must be a string, got ${typeof input}`);
    const trimmed = input.trim();
    if (ANYWHERE_ALIASES.has(trimmed.toLowerCase())) return { label: ANYWHERE, code: null };
    const code = regionCodeFor(trimmed);
    if (code === undefined) {
        throw new Error(
            `Unknown region "${input}". Use an ISO 3166-1 alpha-2 country code such as US, GB, DE or HU, or "anywhere".`,
        );
    }
    return { label: trimmed.toUpperCase(), code };
}
