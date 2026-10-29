/**
 * Input normalisation: domains and advertiser ids.
 * Pure functions, no Apify dependency.
 */

const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?)*$/;

/**
 * Turn whatever a buyer pasted (URL, host with www., mixed case, trailing dot, whitespace)
 * into a bare lower-case registrable host. Returns null when nothing usable is left.
 *
 * Examples: "https://www.Nike.com/en/shoes?x=1" -> "nike.com", "WWW.OTPBANK.HU." -> "otpbank.hu",
 * "münchen.de" -> "xn--mnchen-3ya.de" (what the Transparency Center expects).
 */
export function normalizeDomain(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    let s = raw.trim();
    if (!s) return null;

    // Strip surrounding quotes/brackets people sometimes paste from spreadsheets.
    s = s.replace(/^[\s"'<>()[\]]+|[\s"'<>()[\]]+$/g, '');
    if (!s) return null;

    // Add a scheme so the URL parser gives us the hostname (lower-cased and punycoded).
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `http://${s}`;

    let host: string;
    try {
        host = new URL(withScheme).hostname;
    } catch {
        // Fall back to a manual cut when the URL parser rejects the input (e.g. bad port).
        host = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split(/[/?#]/)[0] ?? '';
        host = host.replace(/^[^@]*@/, '').split(':')[0] ?? '';
    }

    host = host.toLowerCase().replace(/\.+$/, '');
    // Bracketed IPv6 or anything with characters a hostname cannot contain is not a domain.
    if (host.startsWith('[')) return null;
    if (host.startsWith('www.')) host = host.slice(4);
    host = host.replace(/^\.+/, '');
    if (!host || !HOSTNAME_RE.test(host)) return null;
    return host;
}

export interface NormalizedList {
    values: string[];
    invalid: string[];
}

/** Normalise and de-duplicate a domain list, preserving first-seen order. */
export function normalizeDomains(list: unknown): NormalizedList {
    const values: string[] = [];
    const invalid: string[] = [];
    const seen = new Set<string>();
    if (!Array.isArray(list)) return { values, invalid };
    for (const raw of list) {
        const host = normalizeDomain(raw);
        if (!host) {
            if (typeof raw === 'string' && raw.trim()) invalid.push(raw);
            continue;
        }
        if (seen.has(host)) continue;
        seen.add(host);
        values.push(host);
    }
    return { values, invalid };
}

const ADVERTISER_ID_RE = /^AR\d{10,30}$/;

/** Normalise a Google advertiser id ("AR" + digits); accepts a pasted Transparency Center URL. */
export function normalizeAdvertiserId(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    let s = raw.trim();
    if (!s) return null;
    const fromUrl = s.match(/\/advertiser\/(AR\d+)/i);
    if (fromUrl?.[1]) s = fromUrl[1];
    s = s.toUpperCase();
    return ADVERTISER_ID_RE.test(s) ? s : null;
}

export function normalizeAdvertiserIds(list: unknown): NormalizedList {
    const values: string[] = [];
    const invalid: string[] = [];
    const seen = new Set<string>();
    if (!Array.isArray(list)) return { values, invalid };
    for (const raw of list) {
        const id = normalizeAdvertiserId(raw);
        if (!id) {
            if (typeof raw === 'string' && raw.trim()) invalid.push(raw);
            continue;
        }
        if (seen.has(id)) continue;
        seen.add(id);
        values.push(id);
    }
    return { values, invalid };
}
