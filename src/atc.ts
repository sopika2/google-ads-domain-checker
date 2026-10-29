/**
 * SearchCreatives RPC client for the Google Ads Transparency Center.
 *
 * Plain HTTP via got-scraping (browser-consistent headers and TLS), no browser, no login, no cookies needed.
 * One sticky proxy session per target so the pagination cursor stays on the same exit IP, 1 request per
 * `requestDelayMs` per session, and a fresh session + the same cursor on every block.
 */

import { createHash } from 'node:crypto';

import { gotScraping } from 'got-scraping';

import { ParseError, parseSearchCreativesResponse } from './parse.js';
import type { Creative, SearchPage, Target } from './types.js';

export const SEARCH_CREATIVES_URL =
    'https://adstransparency.google.com/anji/_/rpc/SearchService/SearchCreatives?authuser=';
export const PAGE_SIZE_MAX = 100;
export const DEFAULT_RETRY_WAITS_MS = [2_000, 5_000, 10_000];
export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_MAX_CONSECUTIVE_BLOCKED = 10;
export const DEFAULT_MAX_CONSECUTIVE_TRANSPORT_FAILURES = 10;
export const RATE_LIMIT_FATAL_MESSAGE = 'Google is rate-limiting every exit IP; rerun later or switch proxy group';
export const TRANSPORT_FATAL_MESSAGE =
    'Proxy or network is failing on every request; check the proxy configuration (group access, password) and rerun';

const BLOCK_BODY_RE = /recaptcha|unusual traffic|\/sorry\//i;
const SORRY_LOCATION_RE = /google\.com\/sorry|\/sorry\//i;
/** Errors that mean the proxy itself refused us; retrying on the same configuration cannot help. */
const PROXY_FATAL_RE = /proxy responded with|proxy url protocol|407/i;

// ---------------------------------------------------------------------------------------------
// Errors

export type BlockKind = 'http_429' | 'http_403' | 'captcha_redirect' | 'captcha_body';

/** Google refused this exit IP: discard the session and retry on a fresh one. */
export class BlockedError extends Error {
    override name = 'BlockedError';
    constructor(
        public readonly kind: BlockKind,
        public readonly statusCode: number,
        message?: string,
    ) {
        super(message ?? `Blocked by Google (${kind}, HTTP ${statusCode})`);
    }
}

/** Network error, 5xx or non-JSON body without a captcha signature: retry. */
export class TransientError extends Error {
    override name = 'TransientError';
}

/** 4xx other than 429/403, i.e. the request itself is wrong: do not retry. */
export class RequestFailedError extends Error {
    override name = 'RequestFailedError';
    constructor(
        public readonly statusCode: number,
        message: string,
    ) {
        super(message);
    }
}

/** Too many consecutive blocks across sessions: the whole run must stop. */
export class RateLimitFatalError extends Error {
    override name = 'RateLimitFatalError';
    constructor(public readonly consecutiveBlocked: number) {
        super(RATE_LIMIT_FATAL_MESSAGE);
    }
}

/** The transport (proxy, DNS, network) fails on every request: the whole run must stop. */
export class TransportFatalError extends Error {
    override name = 'TransportFatalError';
    constructor(
        public readonly consecutiveFailures: number,
        detail?: string,
    ) {
        super(detail ? `${TRANSPORT_FATAL_MESSAGE} (${detail})` : TRANSPORT_FATAL_MESSAGE);
    }
}

/** The run is stopping (abort, migration, charge limit); the current target is abandoned. */
export class StoppedError extends Error {
    override name = 'StoppedError';
}

// ---------------------------------------------------------------------------------------------
// Transport abstraction (lets tests drive the client without network)

export interface TransportRequest {
    url: string;
    method: 'POST';
    headers: Record<string, string>;
    body: string;
    proxyUrl?: string;
    sessionId: string;
    timeoutMs: number;
}

export interface TransportResponse {
    statusCode: number;
    headers: Record<string, string | string[] | undefined>;
    body: string;
}

export type Transport = (req: TransportRequest) => Promise<TransportResponse>;

/** Navigation-only headers the header generator adds that a browser never sends on an XHR. */
const NAVIGATION_ONLY_HEADERS = ['upgrade-insecure-requests', 'sec-fetch-user'];

/** Default transport: got-scraping with HTTP/2, a Chrome desktop header profile and per-session TLS state. */
export function createGotScrapingTransport(): Transport {
    const sessionTokens = new Map<string, object>();
    return async (req) => {
        let token = sessionTokens.get(req.sessionId);
        if (!token) {
            token = {};
            sessionTokens.set(req.sessionId, token);
        }
        const res = await gotScraping({
            url: req.url,
            method: req.method,
            headers: req.headers,
            body: req.body,
            proxyUrl: req.proxyUrl,
            sessionToken: token,
            responseType: 'text',
            throwHttpErrors: false,
            followRedirect: false,
            retry: { limit: 0 },
            timeout: { request: req.timeoutMs },
            headerGeneratorOptions: {
                // TODO(platform): jmlp reports Google rejecting very new Chrome impersonation profiles (136+);
                // re-verify the ceiling on the first platform run and lower it if 403s appear.
                browsers: [{ name: 'chrome', minVersion: 120, maxVersion: 135 }],
                devices: ['desktop'],
                operatingSystems: ['windows', 'macos'],
                locales: ['en-US'],
            },
            hooks: {
                beforeRequest: [
                    (options) => {
                        for (const name of NAVIGATION_ONLY_HEADERS) {
                            delete options.headers[name];
                            delete options.headers[name.replace(/(^|-)([a-z])/g, (_, p, c: string) => p + c.toUpperCase())];
                        }
                    },
                ],
            },
        });
        return {
            statusCode: res.statusCode,
            headers: res.headers as TransportResponse['headers'],
            body: typeof res.body === 'string' ? res.body : String(res.body ?? ''),
        };
    };
}

// ---------------------------------------------------------------------------------------------
// Payload

export interface SearchPayloadOptions {
    target: Target;
    pageSize: number;
    regionCode: number | null;
    cursor?: string | null;
}

/**
 * Build the `f.req` JSON. Verified live 2026-10-28:
 *   domain:      {"2":100,"3":{"12":{"1":"nike.com","2":true},"8":[2840]},"7":{"1":1}}
 *   advertiser:  {"2":100,"3":{"13":{"1":["AR..."]}},"7":{"1":1}}
 *   next page:   add "4":"<cursor>" at the top level
 */
export function buildSearchPayload({ target, pageSize, regionCode, cursor }: SearchPayloadOptions): Record<string, unknown> {
    const filter: Record<string, unknown> =
        target.kind === 'domain' ? { '12': { '1': target.value, '2': true } } : { '13': { '1': [target.value] } };
    if (regionCode !== null) filter['8'] = [regionCode];
    const payload: Record<string, unknown> = {
        '2': Math.max(1, Math.min(PAGE_SIZE_MAX, Math.trunc(pageSize))),
        '3': filter,
    };
    if (cursor) payload['4'] = cursor;
    payload['7'] = { '1': 1 };
    return payload;
}

export function encodeFormBody(payload: Record<string, unknown>): string {
    return `f.req=${encodeURIComponent(JSON.stringify(payload))}`;
}

export const REQUEST_HEADERS: Readonly<Record<string, string>> = Object.freeze({
    accept: '*/*',
    'accept-language': 'en-US,en;q=0.9',
    origin: 'https://adstransparency.google.com',
    referer: 'https://adstransparency.google.com/',
    'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
    'x-same-domain': '1',
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'cors',
    'sec-fetch-dest': 'empty',
});

// ---------------------------------------------------------------------------------------------
// Client

export interface AtcLogger {
    debug(msg: string, data?: Record<string, unknown>): void;
    info(msg: string, data?: Record<string, unknown>): void;
    warning(msg: string, data?: Record<string, unknown>): void;
}

export interface AtcMetrics {
    requests: number;
    ok_responses: number;
    blocked_429: number;
    blocked_403: number;
    captcha_redirects: number;
    captcha_bodies: number;
    transient_errors: number;
    retries: number;
    bytes: number;
    sessions_opened: number;
    max_consecutive_blocked: number;
    max_consecutive_transport_failures: number;
    pagination_guard_hits: number;
}

export interface AtcClientOptions {
    /** Returns a proxy URL for a session id (Apify ProxyConfiguration.newUrl), or undefined for no proxy. */
    getProxyUrl?: (sessionId: string) => Promise<string | undefined>;
    transport?: Transport;
    /** Minimum gap between two requests on the same session. */
    requestDelayMs: number;
    /** 2000 + ISO numeric, or null for anywhere. */
    regionCode: number | null;
    pageSize?: number;
    maxAttempts?: number;
    retryWaitsMs?: number[];
    maxConsecutiveBlocked?: number;
    maxConsecutiveTransportFailures?: number;
    timeoutMs?: number;
    /** Makes session ids unique per run. */
    sessionSalt?: string;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    log?: AtcLogger;
}

export interface Session {
    id: string;
    proxyUrl: string | undefined;
    lastRequestAt: number;
    requests: number;
}

export interface FetchTargetOptions {
    /** Stop paginating once this many creatives were collected. */
    maxCreatives: number;
    /** Checked between pages and before every retry; return false when the run is stopping. */
    shouldContinue?: () => boolean;
}

export interface FetchTargetResult {
    creatives: Creative[];
    adCountLow: number | null;
    adCountHigh: number | null;
    pages: number;
    /** True when pagination stopped because maxCreatives was reached while Google still had a cursor. */
    truncated: boolean;
    /** True when Google returned no cursor, or the cursor stopped producing new creatives (every creative was read). */
    exhausted: boolean;
    /** True when shouldContinue() returned false: the result is partial and must not be delivered. */
    stoppedEarly: boolean;
}

const defaultLogger: AtcLogger = {
    debug: () => undefined,
    info: (msg) => console.log(msg),
    warning: (msg) => console.warn(msg),
};

export class AtcClient {
    readonly metrics: AtcMetrics = {
        requests: 0,
        ok_responses: 0,
        blocked_429: 0,
        blocked_403: 0,
        captcha_redirects: 0,
        captcha_bodies: 0,
        transient_errors: 0,
        retries: 0,
        bytes: 0,
        sessions_opened: 0,
        max_consecutive_blocked: 0,
        max_consecutive_transport_failures: 0,
        pagination_guard_hits: 0,
    };

    private consecutiveBlocked = 0;
    private consecutiveTransportFailures = 0;
    private readonly transport: Transport;
    private readonly getProxyUrl: (sessionId: string) => Promise<string | undefined>;
    private readonly requestDelayMs: number;
    private readonly regionCode: number | null;
    private readonly pageSize: number;
    private readonly maxAttempts: number;
    private readonly retryWaitsMs: number[];
    private readonly maxConsecutiveBlocked: number;
    private readonly maxConsecutiveTransportFailures: number;
    private readonly timeoutMs: number;
    private readonly sessionSalt: string;
    private readonly sleep: (ms: number) => Promise<void>;
    private readonly now: () => number;
    private readonly log: AtcLogger;

    constructor(options: AtcClientOptions) {
        this.transport = options.transport ?? createGotScrapingTransport();
        this.getProxyUrl = options.getProxyUrl ?? (async () => undefined);
        this.requestDelayMs = Math.max(0, options.requestDelayMs);
        this.regionCode = options.regionCode;
        this.pageSize = Math.max(1, Math.min(PAGE_SIZE_MAX, options.pageSize ?? PAGE_SIZE_MAX));
        this.maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
        this.retryWaitsMs = options.retryWaitsMs ?? DEFAULT_RETRY_WAITS_MS;
        this.maxConsecutiveBlocked = Math.max(1, options.maxConsecutiveBlocked ?? DEFAULT_MAX_CONSECUTIVE_BLOCKED);
        this.maxConsecutiveTransportFailures = Math.max(
            1,
            options.maxConsecutiveTransportFailures ?? DEFAULT_MAX_CONSECUTIVE_TRANSPORT_FAILURES,
        );
        this.timeoutMs = options.timeoutMs ?? 30_000;
        this.sessionSalt = options.sessionSalt ?? 'local';
        this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
        this.now = options.now ?? (() => Date.now());
        this.log = options.log ?? defaultLogger;
    }

    get consecutiveBlockedCount(): number {
        return this.consecutiveBlocked;
    }

    get consecutiveTransportFailureCount(): number {
        return this.consecutiveTransportFailures;
    }

    /** Deterministic within a run: sha1(salt:kind:value:attempt), 40 hex chars, valid for Apify Proxy. */
    sessionIdFor(target: Target, attempt: number): string {
        return createHash('sha1').update(`${this.sessionSalt}:${target.kind}:${target.value}:${attempt}`).digest('hex');
    }

    async openSession(target: Target, attempt: number): Promise<Session> {
        const id = this.sessionIdFor(target, attempt);
        const proxyUrl = await this.getProxyUrl(id);
        this.metrics.sessions_opened++;
        return { id, proxyUrl, lastRequestAt: 0, requests: 0 };
    }

    /** Fetch creatives for one target, paginating until maxCreatives or the last page. */
    async fetchTarget(target: Target, options: FetchTargetOptions): Promise<FetchTargetResult> {
        const maxCreatives = Math.max(1, Math.trunc(options.maxCreatives));
        const shouldContinue = options.shouldContinue ?? (() => true);
        // A well-behaved server needs ceil(max / pageSize) pages; allow a little slack for short pages.
        const maxPages = Math.ceil(maxCreatives / this.pageSize) + 2;
        const creatives: Creative[] = [];
        const seen = new Set<string>();
        let adCountLow: number | null = null;
        let adCountHigh: number | null = null;
        let cursor: string | null = null;
        let pages = 0;
        let truncated = false;
        let exhausted = false;
        let stoppedEarly = false;

        const sessionRef: { current: Session; attempt: number } = {
            current: await this.openSession(target, 0),
            attempt: 0,
        };

        for (;;) {
            const remaining = maxCreatives - creatives.length;
            const pageSize = Math.min(this.pageSize, Math.max(1, remaining));
            let page: SearchPage;
            try {
                page = await this.fetchPageWithRetry(target, cursor, pageSize, sessionRef, shouldContinue);
            } catch (err) {
                if (err instanceof StoppedError) {
                    stoppedEarly = true;
                    break;
                }
                throw err;
            }
            pages++;

            if (page.adCountLow !== null) adCountLow = page.adCountLow;
            if (page.adCountHigh !== null) adCountHigh = page.adCountHigh;
            const before = creatives.length;
            for (const c of page.creatives) {
                if (seen.has(c.creativeId)) continue;
                seen.add(c.creativeId);
                creatives.push(c);
            }
            const added = creatives.length - before;

            if (!page.nextCursor || page.creatives.length === 0) {
                exhausted = true;
                break;
            }
            if (creatives.length >= maxCreatives) {
                truncated = true;
                break;
            }
            if (added === 0 || page.nextCursor === cursor) {
                // Google re-served a page or stopped advancing the cursor: treat as the end of the listing.
                this.metrics.pagination_guard_hits++;
                this.log.warning(`${target.value}: pagination stopped advancing after ${creatives.length} creatives (page ${pages}); treating as the last page`);
                exhausted = true;
                break;
            }
            if (pages >= maxPages) {
                this.metrics.pagination_guard_hits++;
                this.log.warning(`${target.value}: page cap ${maxPages} reached with ${creatives.length} creatives; stopping`);
                truncated = true;
                break;
            }
            if (!shouldContinue()) {
                stoppedEarly = true;
                break;
            }
            cursor = page.nextCursor;
        }

        return {
            creatives: creatives.slice(0, maxCreatives),
            adCountLow,
            adCountHigh,
            pages,
            truncated,
            exhausted,
            stoppedEarly,
        };
    }

    /**
     * One page with the retry policy: on a block, discard the session, open a fresh one and retry the
     * same cursor; on a transient error, retry on the same session. Waits 2 s / 5 s / 10 s between attempts.
     * Throws StoppedError instead of retrying when shouldContinue() is false.
     */
    async fetchPageWithRetry(
        target: Target,
        cursor: string | null,
        pageSize: number,
        sessionRef: { current: Session; attempt: number },
        shouldContinue: () => boolean = () => true,
    ): Promise<SearchPage> {
        let lastError: Error | null = null;
        for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
            if (attempt > 0) {
                if (!shouldContinue()) throw new StoppedError(`Run stopping; not retrying ${target.value}`);
                const wait = this.retryWaitsMs[Math.min(attempt - 1, this.retryWaitsMs.length - 1)] ?? 0;
                this.metrics.retries++;
                this.log.info(`Retry ${attempt}/${this.maxAttempts - 1} for ${target.value} after ${wait} ms`, {
                    reason: lastError?.message,
                });
                await this.sleep(wait);
                if (!shouldContinue()) throw new StoppedError(`Run stopping; not retrying ${target.value}`);
            }
            try {
                return await this.fetchPage(target, cursor, pageSize, sessionRef.current);
            } catch (err) {
                if (err instanceof RateLimitFatalError || err instanceof TransportFatalError) throw err;
                if (err instanceof BlockedError) {
                    lastError = err;
                    // Discard the blocked session; the next attempt gets a new exit IP.
                    sessionRef.attempt++;
                    sessionRef.current = await this.openSession(target, sessionRef.attempt);
                    continue;
                }
                if (err instanceof TransientError) {
                    lastError = err;
                    continue;
                }
                throw err;
            }
        }
        throw lastError ?? new TransientError(`Giving up on ${target.value} after ${this.maxAttempts} attempts`);
    }

    /** One paced request on one session. Classifies the response and updates counters. */
    async fetchPage(target: Target, cursor: string | null, pageSize: number, session: Session): Promise<SearchPage> {
        await this.pace(session);

        const payload = buildSearchPayload({ target, pageSize, regionCode: this.regionCode, cursor });
        const req: TransportRequest = {
            url: SEARCH_CREATIVES_URL,
            method: 'POST',
            headers: { ...REQUEST_HEADERS },
            body: encodeFormBody(payload),
            proxyUrl: session.proxyUrl,
            sessionId: session.id,
            timeoutMs: this.timeoutMs,
        };

        this.metrics.requests++;
        session.requests++;
        session.lastRequestAt = this.now();

        let res: TransportResponse;
        try {
            res = await this.transport(req);
        } catch (err) {
            return this.transportFailed(target, err as Error);
        }
        // Any HTTP response at all means the transport works.
        this.consecutiveTransportFailures = 0;
        const body = typeof res.body === 'string' ? res.body : String(res.body ?? '');
        this.metrics.bytes += Buffer.byteLength(body, 'utf8');

        const status = res.statusCode;
        if (status === 429) return this.blocked('http_429', status, target);
        if (status === 403) return this.blocked('http_403', status, target);
        if (status >= 300 && status < 400) {
            const location = headerValue(res.headers, 'location') ?? '';
            if (SORRY_LOCATION_RE.test(location)) return this.blocked('captcha_redirect', status, target, location);
        }
        // A captcha / "unusual traffic" interstitial is a block whatever status code carries it.
        if (status !== 200 && BLOCK_BODY_RE.test(body)) return this.blocked('captcha_body', status, target);
        if (status >= 300 && status < 400) {
            const location = headerValue(res.headers, 'location') ?? '';
            this.metrics.transient_errors++;
            throw new TransientError(`Unexpected redirect (HTTP ${status}) to ${location || '<no location>'} for ${target.value}`);
        }
        if (status >= 500) {
            this.metrics.transient_errors++;
            throw new TransientError(`Google returned HTTP ${status} for ${target.value}`);
        }
        if (status >= 400) {
            throw new RequestFailedError(status, `Google rejected the request for ${target.value} with HTTP ${status}: ${body.slice(0, 200)}`);
        }

        try {
            const page = parseSearchCreativesResponse(body);
            this.consecutiveBlocked = 0;
            this.metrics.ok_responses++;
            return page;
        } catch (err) {
            if (err instanceof ParseError) {
                if (BLOCK_BODY_RE.test(body)) return this.blocked('captcha_body', status, target);
                this.metrics.transient_errors++;
                throw new TransientError(`Unparseable response for ${target.value}: ${err.message}`);
            }
            throw err;
        }
    }

    private async pace(session: Session): Promise<void> {
        if (session.lastRequestAt === 0 || this.requestDelayMs === 0) return;
        const wait = session.lastRequestAt + this.requestDelayMs - this.now();
        if (wait > 0) await this.sleep(wait);
    }

    private transportFailed(target: Target, err: Error): never {
        this.metrics.transient_errors++;
        this.consecutiveTransportFailures++;
        this.metrics.max_consecutive_transport_failures = Math.max(
            this.metrics.max_consecutive_transport_failures,
            this.consecutiveTransportFailures,
        );
        const message = err?.message ?? String(err);
        if (PROXY_FATAL_RE.test(message)) {
            throw new TransportFatalError(this.consecutiveTransportFailures, message);
        }
        if (this.consecutiveTransportFailures >= this.maxConsecutiveTransportFailures) {
            throw new TransportFatalError(this.consecutiveTransportFailures, `last error: ${message}`);
        }
        throw new TransientError(`Network error for ${target.value}: ${message}`);
    }

    private blocked(kind: BlockKind, status: number, target: Target, detail?: string): never {
        if (kind === 'http_429') this.metrics.blocked_429++;
        else if (kind === 'http_403') this.metrics.blocked_403++;
        else if (kind === 'captcha_redirect') this.metrics.captcha_redirects++;
        else this.metrics.captcha_bodies++;

        this.consecutiveBlocked++;
        this.metrics.max_consecutive_blocked = Math.max(this.metrics.max_consecutive_blocked, this.consecutiveBlocked);
        this.log.warning(`Blocked (${kind}, HTTP ${status}) on ${target.value}; consecutive blocks: ${this.consecutiveBlocked}`, {
            detail,
        });
        if (this.consecutiveBlocked >= this.maxConsecutiveBlocked) {
            throw new RateLimitFatalError(this.consecutiveBlocked);
        }
        throw new BlockedError(kind, status);
    }
}

function headerValue(headers: TransportResponse['headers'], name: string): string | undefined {
    const direct = headers[name] ?? headers[name.toLowerCase()];
    if (Array.isArray(direct)) return direct[0];
    if (typeof direct === 'string') return direct;
    for (const [k, v] of Object.entries(headers)) {
        if (k.toLowerCase() === name.toLowerCase()) return Array.isArray(v) ? v[0] : v;
    }
    return undefined;
}
