import { describe, expect, it } from 'vitest';

import {
    AtcClient,
    BlockedError,
    DEFAULT_RETRY_WAITS_MS,
    PAGE_SIZE_MAX,
    RATE_LIMIT_FATAL_MESSAGE,
    RateLimitFatalError,
    REQUEST_HEADERS,
    RequestFailedError,
    SEARCH_CREATIVES_URL,
    TransientError,
    buildSearchPayload,
    encodeFormBody,
    type Transport,
    type TransportRequest,
    type TransportResponse,
} from '../src/atc.js';
import type { Target } from '../src/types.js';
import { fixtureText } from './helpers.js';

const nikePage1 = fixtureText('nike-com.json');
const nikePage2 = fixtureText('nike-com-page2.json');
const nikeCursor = (JSON.parse(nikePage1) as { 2: string })[2];
const nike: Target = { kind: 'domain', value: 'nike.com' };

function decodePayload(req: TransportRequest): Record<string, any> {
    expect(req.body.startsWith('f.req=')).toBe(true);
    return JSON.parse(decodeURIComponent(req.body.slice('f.req='.length)));
}

const ok = (body: string): TransportResponse => ({ statusCode: 200, headers: { 'content-type': 'application/json; charset=utf-8' }, body });
const status = (statusCode: number, body = '', headers: TransportResponse['headers'] = {}): TransportResponse => ({ statusCode, headers, body });

/** Scripted transport: each call pops the next responder; records every request. */
function scripted(responders: Array<(req: TransportRequest) => TransportResponse | Promise<TransportResponse>>) {
    const requests: TransportRequest[] = [];
    const transport: Transport = async (req) => {
        requests.push(req);
        const next = responders.shift();
        if (!next) throw new Error(`No scripted response for request #${requests.length}`);
        return next(req);
    };
    return { transport, requests };
}

function makeClient(transport: Transport, overrides: Partial<ConstructorParameters<typeof AtcClient>[0]> = {}) {
    const sleeps: number[] = [];
    let clock = 1_000_000;
    const proxyCalls: string[] = [];
    const client = new AtcClient({
        transport,
        requestDelayMs: 1000,
        regionCode: null,
        sleep: async (ms) => {
            sleeps.push(ms);
            clock += ms;
        },
        now: () => clock,
        getProxyUrl: async (sessionId) => {
            proxyCalls.push(sessionId);
            return `http://session-${sessionId}@proxy.local:8000`;
        },
        log: { debug: () => undefined, info: () => undefined, warning: () => undefined },
        sessionSalt: 'test',
        ...overrides,
    });
    return { client, sleeps, proxyCalls, tick: (ms: number) => (clock += ms) };
}

describe('buildSearchPayload / encodeFormBody', () => {
    it('matches the verified request shapes byte for byte', () => {
        expect(JSON.stringify(buildSearchPayload({ target: nike, pageSize: 100, regionCode: null }))).toBe(
            '{"2":100,"3":{"12":{"1":"nike.com","2":true}},"7":{"1":1}}',
        );
        // JS orders integer-like keys numerically, so "8" precedes "12"; the server parses JSON, so order is irrelevant.
        expect(JSON.stringify(buildSearchPayload({ target: nike, pageSize: 100, regionCode: 2840 }))).toBe(
            '{"2":100,"3":{"8":[2840],"12":{"1":"nike.com","2":true}},"7":{"1":1}}',
        );
        expect(JSON.stringify(buildSearchPayload({ target: { kind: 'advertiser', value: 'AR16735076323512287233' }, pageSize: 100, regionCode: null }))).toBe(
            '{"2":100,"3":{"13":{"1":["AR16735076323512287233"]}},"7":{"1":1}}',
        );
        expect(JSON.stringify(buildSearchPayload({ target: nike, pageSize: 100, regionCode: null, cursor: 'abc=' }))).toBe(
            '{"2":100,"3":{"12":{"1":"nike.com","2":true}},"4":"abc=","7":{"1":1}}',
        );
    });

    it('clamps the page size to 1..100', () => {
        expect(buildSearchPayload({ target: nike, pageSize: 500, regionCode: null })['2']).toBe(PAGE_SIZE_MAX);
        expect(buildSearchPayload({ target: nike, pageSize: 0, regionCode: null })['2']).toBe(1);
        expect(buildSearchPayload({ target: nike, pageSize: 33.9, regionCode: null })['2']).toBe(33);
    });

    it('url-encodes the JSON as the f.req form field', () => {
        const body = encodeFormBody({ '2': 1, '3': { '12': { '1': 'a b.com', '2': true } } });
        expect(body).toBe('f.req=%7B%222%22%3A1%2C%223%22%3A%7B%2212%22%3A%7B%221%22%3A%22a%20b.com%22%2C%222%22%3Atrue%7D%7D%7D');
    });

    it('declares the headers the Transparency Center front-end sends', () => {
        expect(REQUEST_HEADERS).toMatchObject({
            origin: 'https://adstransparency.google.com',
            referer: 'https://adstransparency.google.com/',
            'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
            'x-same-domain': '1',
        });
        expect(SEARCH_CREATIVES_URL).toBe('https://adstransparency.google.com/anji/_/rpc/SearchService/SearchCreatives?authuser=');
    });
});

describe('AtcClient sessions', () => {
    it('derives Apify-proxy-safe session ids that change per attempt', () => {
        const { client } = makeClient(async () => ok('{}'));
        const a = client.sessionIdFor(nike, 0);
        const b = client.sessionIdFor(nike, 1);
        expect(a).toMatch(/^[0-9a-f]{40}$/);
        expect(b).toMatch(/^[0-9a-f]{40}$/);
        expect(a).not.toBe(b);
        expect(client.sessionIdFor({ kind: 'domain', value: 'adidas.com' }, 0)).not.toBe(a);
        expect(client.sessionIdFor(nike, 0)).toBe(a);
    });
});

describe('AtcClient.fetchTarget', () => {
    it('paginates with the cursor on one sticky session and respects maxCreatives', async () => {
        const { transport, requests } = scripted([() => ok(nikePage1), () => ok(nikePage2)]);
        const { client, proxyCalls } = makeClient(transport);
        const result = await client.fetchTarget(nike, { maxCreatives: 150 });

        expect(requests).toHaveLength(2);
        expect(decodePayload(requests[0]!)).toEqual({ '2': 100, '3': { '12': { '1': 'nike.com', '2': true } }, '7': { '1': 1 } });
        expect(decodePayload(requests[1]!)).toEqual({ '2': 50, '3': { '12': { '1': 'nike.com', '2': true } }, '4': nikeCursor, '7': { '1': 1 } });
        expect(requests[0]!.sessionId).toBe(requests[1]!.sessionId);
        expect(requests[0]!.proxyUrl).toBe(`http://session-${requests[0]!.sessionId}@proxy.local:8000`);
        expect(requests[0]!.url).toBe(SEARCH_CREATIVES_URL);
        expect(requests[0]!.headers).toMatchObject(REQUEST_HEADERS);
        expect(proxyCalls).toHaveLength(1);

        expect(result.creatives).toHaveLength(150);
        expect(new Set(result.creatives.map((c) => c.creativeId)).size).toBe(150);
        expect(result.pages).toBe(2);
        expect(result.truncated).toBe(true);
        expect(result.exhausted).toBe(false);
        expect(result.adCountLow).toBe(50_000);
        expect(client.metrics).toMatchObject({ requests: 2, ok_responses: 2, retries: 0, sessions_opened: 1 });
        expect(client.metrics.bytes).toBe(Buffer.byteLength(nikePage1) + Buffer.byteLength(nikePage2));
    });

    it('stops at the last page and reports exhausted', async () => {
        const lastPage = JSON.stringify({ ...(JSON.parse(nikePage2) as object), 2: undefined });
        const { transport, requests } = scripted([() => ok(nikePage1), () => ok(lastPage)]);
        const { client } = makeClient(transport);
        const result = await client.fetchTarget(nike, { maxCreatives: 5000 });
        expect(requests).toHaveLength(2);
        expect(result.creatives).toHaveLength(200);
        expect(result.exhausted).toBe(true);
        expect(result.truncated).toBe(false);
    });

    it('requests only the sample size on the first page and returns an empty result for no ads', async () => {
        const { transport, requests } = scripted([() => ok('{}')]);
        const { client } = makeClient(transport);
        const result = await client.fetchTarget({ kind: 'domain', value: 'example.org' }, { maxCreatives: 20 });
        expect(decodePayload(requests[0]!)['2']).toBe(20);
        expect(result).toEqual({ creatives: [], adCountLow: null, adCountHigh: null, pages: 1, truncated: false, exhausted: true, stoppedEarly: false });
    });

    it('paces requests on the same session to requestDelayMs', async () => {
        const { transport } = scripted([() => ok(nikePage1), () => ok(nikePage2)]);
        const { client, sleeps } = makeClient(transport, { requestDelayMs: 1000 });
        await client.fetchTarget(nike, { maxCreatives: 200 });
        expect(sleeps).toEqual([1000]);
    });

    it('honours shouldContinue between pages', async () => {
        const { transport, requests } = scripted([() => ok(nikePage1), () => ok(nikePage2)]);
        const { client } = makeClient(transport);
        const result = await client.fetchTarget(nike, { maxCreatives: 1000, shouldContinue: () => false });
        expect(requests).toHaveLength(1);
        expect(result.stoppedEarly).toBe(true);
        expect(result.truncated).toBe(false);
        expect(result.exhausted).toBe(false);
        expect(result.creatives).toHaveLength(100);
    });
});

describe('AtcClient retry policy', () => {
    it('on HTTP 429 discards the session, waits 2 s and retries the same cursor on a fresh session', async () => {
        const { transport, requests } = scripted([() => ok(nikePage1), () => status(429, 'Too Many Requests'), () => ok(nikePage2)]);
        const { client, sleeps, proxyCalls } = makeClient(transport);
        const result = await client.fetchTarget(nike, { maxCreatives: 200 });

        expect(requests).toHaveLength(3);
        expect(decodePayload(requests[1]!)['4']).toBe(nikeCursor);
        expect(decodePayload(requests[2]!)['4']).toBe(nikeCursor);
        expect(requests[2]!.sessionId).not.toBe(requests[1]!.sessionId);
        expect(proxyCalls).toHaveLength(2);
        expect(sleeps).toEqual([1000, DEFAULT_RETRY_WAITS_MS[0]]);
        expect(result.creatives).toHaveLength(200);
        expect(client.metrics).toMatchObject({ blocked_429: 1, retries: 1, sessions_opened: 2, ok_responses: 2, requests: 3 });
        expect(client.consecutiveBlockedCount).toBe(0);
    });

    it('treats a 302 to /sorry/ and a reCAPTCHA body as blocks', async () => {
        const { transport } = scripted([
            () => status(302, '', { location: 'https://www.google.com/sorry/index?continue=https://adstransparency.google.com/' }),
            () => status(200, '<html><body>Our systems have detected unusual traffic. <div class="g-recaptcha"></div></body></html>', { 'content-type': 'text/html' }),
            () => status(403, 'Forbidden'),
            () => ok(nikePage1),
        ]);
        const { client, sleeps } = makeClient(transport, { maxAttempts: 4 });
        const result = await client.fetchTarget(nike, { maxCreatives: 100 });
        expect(result.creatives).toHaveLength(100);
        expect(client.metrics).toMatchObject({ captcha_redirects: 1, captcha_bodies: 1, blocked_403: 1, retries: 3, sessions_opened: 4 });
        expect(sleeps).toEqual([2000, 5000, 10000]);
    });

    it('gives up on a target after maxAttempts blocks without touching other targets', async () => {
        const { transport, requests } = scripted([() => status(429), () => status(429), () => status(429), () => ok(nikePage1)]);
        const { client, sleeps } = makeClient(transport);
        await expect(client.fetchTarget(nike, { maxCreatives: 100 })).rejects.toBeInstanceOf(BlockedError);
        expect(requests).toHaveLength(3);
        expect(sleeps).toEqual([2000, 5000]);
        expect(client.consecutiveBlockedCount).toBe(3);
        // The next target gets its own fresh session and succeeds; the counter resets.
        const next = await client.fetchTarget({ kind: 'domain', value: 'adidas.com' }, { maxCreatives: 100 });
        expect(next.creatives).toHaveLength(100);
        expect(client.consecutiveBlockedCount).toBe(0);
    });

    it('fails the run after 10 consecutive blocked requests across sessions', async () => {
        const { transport, requests } = scripted(Array.from({ length: 12 }, () => () => status(429)));
        const { client } = makeClient(transport, { maxAttempts: 20 });
        const err = await client.fetchTarget(nike, { maxCreatives: 100 }).catch((e) => e);
        expect(err).toBeInstanceOf(RateLimitFatalError);
        expect((err as RateLimitFatalError).message).toBe(RATE_LIMIT_FATAL_MESSAGE);
        expect((err as RateLimitFatalError).consecutiveBlocked).toBe(10);
        expect(requests).toHaveLength(10);
        expect(client.metrics.max_consecutive_blocked).toBe(10);
    });

    it('retries transient failures (5xx, network, non-JSON) on the same session and surfaces the last error', async () => {
        const { transport, requests } = scripted([
            () => status(503, 'Service Unavailable'),
            () => {
                throw new Error('ECONNRESET');
            },
            () => status(200, '<html>maintenance</html>', { 'content-type': 'text/html' }),
            () => ok(nikePage1),
        ]);
        const { client, sleeps } = makeClient(transport, { maxAttempts: 4 });
        const result = await client.fetchTarget(nike, { maxCreatives: 100 });
        expect(result.creatives).toHaveLength(100);
        expect(new Set(requests.map((r) => r.sessionId)).size).toBe(1);
        expect(client.metrics).toMatchObject({ transient_errors: 3, retries: 3, sessions_opened: 1 });
        expect(sleeps).toEqual([2000, 5000, 10000]);

        const { transport: failing } = scripted([() => status(500), () => status(500), () => status(500)]);
        const { client: client2 } = makeClient(failing);
        await expect(client2.fetchTarget(nike, { maxCreatives: 100 })).rejects.toBeInstanceOf(TransientError);
    });

    it('does not retry a 400 (bad request)', async () => {
        const { transport, requests } = scripted([() => status(400, 'Bad Request')]);
        const { client, sleeps } = makeClient(transport);
        await expect(client.fetchTarget(nike, { maxCreatives: 100 })).rejects.toBeInstanceOf(RequestFailedError);
        expect(requests).toHaveLength(1);
        expect(sleeps).toEqual([]);
    });

    it('treats an unexpected redirect as transient, not as a block', async () => {
        const { transport } = scripted([() => status(302, '', { Location: 'https://adstransparency.google.com/other' }), () => ok(nikePage1)]);
        const { client } = makeClient(transport);
        await client.fetchTarget(nike, { maxCreatives: 100 });
        expect(client.metrics).toMatchObject({ transient_errors: 1, captcha_redirects: 0, sessions_opened: 1 });
    });
});
