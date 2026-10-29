/**
 * Google Ads Domain Checker: Apify actor entry point.
 *
 * Orchestrates input normalisation, one sticky proxy session per target, pacing, retries,
 * check/ads/both rows, run-to-run change detection, pay-per-event charging and honest failure.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { Actor, log, type ProxyConfiguration } from 'apify';

import {
    AtcClient,
    BlockedError,
    RateLimitFatalError,
    RequestFailedError,
    TransientError,
    TransportFatalError,
    type FetchTargetResult,
} from './atc.js';
import { diffCreatives, type DiffResult } from './changes.js';
import { buildAdRow, buildCheckRow, buildEndedAdRow, buildErrorRow, type DeriveContext } from './derive.js';
import { planFetch, resolveInput, TARGET_SOFT_CAP } from './input.js';
import type { ActorInput, AdRow, CheckRow, DomainState, RunMetrics, Target } from './types.js';

export const EVENT_DOMAIN_CHECK = 'domain-check';
export const EVENT_AD_ROW = 'ad-row';
const PROGRESS_KEY = 'PROGRESS';

type DeliveryCounters = Pick<
    RunMetrics,
    | 'targets_ok'
    | 'targets_no_ads'
    | 'targets_error'
    | 'targets_dropped_budget'
    | 'domain_rows_pushed'
    | 'ad_rows_pushed'
    | 'domain_checks_charged'
    | 'ad_rows_charged'
>;

interface Progress {
    run_id: string;
    done: string[];
    delivered: DeliveryCounters;
}

type Outcome = 'delivered' | 'no_ads' | 'error' | 'dropped_budget' | 'stopped';

/**
 * Local development only: when ACTOR_TEST_PAY_PER_EVENT=true and no pricing info was injected,
 * load .actor/pay_per_event.json so Actor.charge() logs the real prices (the SDK counts every event as $1
 * towards ACTOR_MAX_TOTAL_CHARGE_USD locally regardless). Must run before Actor.init().
 */
function injectLocalPricingInfo(): void {
    if (process.env.APIFY_IS_AT_HOME) return;
    if (process.env.ACTOR_TEST_PAY_PER_EVENT !== 'true' && process.env.ACTOR_TEST_PAY_PER_EVENT !== '1') return;
    if (process.env.APIFY_ACTOR_PRICING_INFO) return;
    const file = resolve(process.cwd(), '.actor', 'pay_per_event.json');
    if (!existsSync(file)) return;
    try {
        const events = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
        process.env.APIFY_ACTOR_PRICING_INFO = JSON.stringify({
            pricingModel: 'PAY_PER_EVENT',
            pricingPerEvent: { actorChargeEvents: events },
        });
        process.env.APIFY_CHARGED_ACTOR_EVENT_COUNTS ??= '{}';
        log.info(`Local pay-per-event test mode: prices loaded from ${file}`);
    } catch (err) {
        log.warning(`Could not load ${file}: ${(err as Error).message}`);
    }
}

async function createProxy(input: ActorInput['proxyConfiguration']): Promise<ProxyConfiguration | undefined> {
    const config = input ?? { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] };
    if (config.useApifyProxy === false && !(config.proxyUrls && config.proxyUrls.length > 0)) {
        log.warning('Running WITHOUT a proxy. Google throttles unproxied and datacenter IPs quickly; expect 429s at volume.');
        return undefined;
    }
    try {
        const proxy = await Actor.createProxyConfiguration(config);
        if (!proxy) return undefined;
        // Locally without APIFY_PROXY_PASSWORD the SDK only warns; an Apify Proxy URL without a password cannot work.
        const usesApifyProxy = config.useApifyProxy !== false && !(config.proxyUrls && config.proxyUrls.length > 0);
        if (usesApifyProxy && !Actor.isAtHome() && !(proxy as unknown as { password?: string }).password) {
            log.warning('No APIFY_PROXY_PASSWORD / APIFY_TOKEN available locally; running WITHOUT a proxy.');
            return undefined;
        }
        return proxy;
    } catch (err) {
        if (Actor.isAtHome()) throw err;
        log.warning(`Proxy configuration failed locally (${(err as Error).message}); running WITHOUT a proxy.`);
        return undefined;
    }
}

function describeError(err: unknown): string {
    if (err instanceof RateLimitFatalError || err instanceof TransportFatalError) return err.message;
    if (err instanceof BlockedError) return `blocked by Google after retries (${err.kind}, HTTP ${err.statusCode})`;
    if (err instanceof RequestFailedError) return `request rejected (HTTP ${err.statusCode})`;
    if (err instanceof TransientError) return `transient error after retries: ${err.message}`;
    return err instanceof Error ? err.message : String(err);
}

const EMPTY_COUNTERS: DeliveryCounters = {
    targets_ok: 0,
    targets_no_ads: 0,
    targets_error: 0,
    targets_dropped_budget: 0,
    domain_rows_pushed: 0,
    ad_rows_pushed: 0,
    domain_checks_charged: 0,
    ad_rows_charged: 0,
};

function pickCounters(m: RunMetrics): DeliveryCounters {
    const out = { ...EMPTY_COUNTERS };
    for (const k of Object.keys(EMPTY_COUNTERS) as (keyof DeliveryCounters)[]) out[k] = m[k];
    return out;
}

async function main(): Promise<void> {
    const startedAt = new Date();
    const rawInput = await Actor.getInput<ActorInput>();
    log.info('Input received', { input: rawInput });

    const input = resolveInput(rawInput);
    for (const bad of input.invalidInputs) log.warning(`Ignoring invalid target: ${JSON.stringify(bad)}`);
    if (input.truncatedTargets > 0) {
        log.warning(`Soft cap: only the first ${TARGET_SOFT_CAP} targets are processed; ${input.truncatedTargets} were dropped. Split the list across runs.`);
    }
    if (input.targets.length === 0) {
        await Actor.fail('No valid targets: provide at least one domain in "domains" (or an AR... id in "advertiserIds").');
        return;
    }

    const wantCheck = input.mode !== 'ads';
    const wantAds = input.mode !== 'check';
    const plan = planFetch(input);
    log.info(`Mode ${input.mode}, region ${input.region.label}, ${input.targets.length} target(s), sample ${input.sampleSize}, max ads/domain ${input.maxAdsPerDomain}, ${input.maxConcurrency} parallel session(s), ${input.requestDelayMs} ms/request/session`);

    // Pay-per-event sanity check: an event missing in the Console would deliver rows for free.
    const pricing = Actor.getChargingManager().getPricingInfo();
    const isPpe = pricing.isPayPerEvent;
    if (isPpe) {
        log.info(`Pay-per-event pricing active: ${JSON.stringify(pricing.perEventPrices)}, max total ${pricing.maxTotalChargeUsd === Infinity ? 'unlimited' : `$${pricing.maxTotalChargeUsd}`}`);
        if (Actor.isAtHome()) {
            const needed = [wantCheck ? EVENT_DOMAIN_CHECK : null, wantAds ? EVENT_AD_ROW : null].filter((e): e is string => !!e);
            const missing = needed.filter((e) => pricing.perEventPrices[e] === undefined);
            if (missing.length > 0) {
                await Actor.fail(`Pay-per-event is active but the event(s) ${missing.join(', ')} are not defined for this actor in the Apify Console (Publication > Pay per event). Nothing was charged.`);
                return;
            }
        }
    } else {
        log.info('Not running under pay-per-event pricing; rows are pushed without charging.');
    }

    const proxyConfiguration = await createProxy(rawInput?.proxyConfiguration);
    const env = Actor.getEnv();
    const client = new AtcClient({
        getProxyUrl: async (sessionId) => (proxyConfiguration ? await proxyConfiguration.newUrl(sessionId) : undefined),
        requestDelayMs: input.requestDelayMs,
        regionCode: input.region.code,
        sessionSalt: env.actorRunId ?? `local-${startedAt.getTime()}`,
        log: {
            debug: (m, d) => log.debug(m, d),
            info: (m, d) => log.info(m, d),
            warning: (m, d) => log.warning(m, d),
        },
    });

    const stateStore = input.trackChanges ? await Actor.openKeyValueStore(input.stateStoreName) : null;
    if (stateStore) log.info(`Change tracking ON, state store "${input.stateStoreName}"`);
    // Snapshots are per target and per region: different regions return different creative sets.
    const stateKeyFor = (t: Target) => (input.region.label === 'anywhere' ? t.value : `${t.value}_${input.region.label}`);

    const metrics: RunMetrics = {
        requests: 0,
        ok_responses: 0,
        blocked_429: 0,
        captcha_redirects: 0,
        captcha_bodies: 0,
        transient_errors: 0,
        retries: 0,
        bytes: 0,
        targets_total: input.targets.length,
        ...EMPTY_COUNTERS,
        charge_limit_reached: false,
        aborted: false,
    };
    const errorsByMessage = new Map<string, number>();
    let stop = false;
    let fatal: RateLimitFatalError | TransportFatalError | null = null;
    let remainingDomainChecks: number | null = null;
    /** Creative ids reserved for delivery in this run; reserved synchronously so parallel workers never double-charge. */
    const chargedCreativeIds = new Set<string>();

    // Progress survives a platform migration or a resurrect (same run id, same default store): targets whose
    // rows were delivered and charged are skipped. Never resumes locally.
    const targetKey = (t: Target) => `${t.kind}:${t.value}`;
    const previousProgress = await Actor.getValue<Progress>(PROGRESS_KEY);
    const resumed = !!(env.actorRunId && previousProgress && previousProgress.run_id === env.actorRunId);
    const doneTargets = new Set<string>(resumed ? (previousProgress!.done ?? []) : []);
    if (resumed) {
        Object.assign(metrics, { ...EMPTY_COUNTERS, ...(previousProgress!.delivered ?? {}) });
        log.info(`Resuming run ${env.actorRunId}: ${doneTargets.size} target(s) were already delivered and will be skipped; request counters restart from zero.`);
    }

    const snapshot = () => ({
        ...metrics,
        requests: client.metrics.requests,
        ok_responses: client.metrics.ok_responses,
        blocked_429: client.metrics.blocked_429 + client.metrics.blocked_403,
        captcha_redirects: client.metrics.captcha_redirects,
        captcha_bodies: client.metrics.captcha_bodies,
        transient_errors: client.metrics.transient_errors,
        retries: client.metrics.retries,
        bytes: client.metrics.bytes,
        sessions_opened: client.metrics.sessions_opened,
        max_consecutive_blocked: client.metrics.max_consecutive_blocked,
        max_consecutive_transport_failures: client.metrics.max_consecutive_transport_failures,
        pagination_guard_hits: client.metrics.pagination_guard_hits,
        mode: input.mode,
        region: input.region.label,
        resumed,
        started_at: startedAt.toISOString(),
        updated_at: new Date().toISOString(),
    });
    const persist = async () => {
        try {
            // PROGRESS first: it is what a rebooted container needs; OUTPUT is informational.
            if (env.actorRunId) {
                const progress: Progress = { run_id: env.actorRunId, done: [...doneTargets], delivered: pickCounters(metrics) };
                await Actor.setValue(PROGRESS_KEY, progress);
            }
            await Actor.setValue('OUTPUT', snapshot());
        } catch (err) {
            log.warning(`Could not persist progress: ${(err as Error).message}`);
        }
    };

    // Abort / migration: stop taking new targets, let in-flight targets finish (pagination and retries stop
    // at the next page), persist, and only then let the SDK exit or reboot. The handlers return promises so
    // the SDK's graceful-shutdown exit()/reboot() waits for them.
    let workersDone: Promise<void> = Promise.resolve();
    let draining = false;
    const drain = async (reason: 'aborting' | 'migrating'): Promise<void> => {
        if (!draining) {
            draining = true;
            stop = true;
            if (reason === 'aborting') metrics.aborted = true;
            log.warning(`Run is ${reason}; finishing in-flight targets and saving progress.`);
        }
        await workersDone;
        await persist();
        if (reason === 'aborting') {
            try {
                await Actor.setStatusMessage(`Aborted after ${processedCount()}/${metrics.targets_total} targets. ${summaryLine()}`);
            } catch {
                /* best effort */
            }
        }
    };
    Actor.on('aborting', () => drain('aborting'));
    Actor.on('migrating', () => drain('migrating'));
    Actor.on('persistState', () => persist());

    const processedCount = () => metrics.targets_ok + metrics.targets_no_ads + metrics.targets_error + metrics.targets_dropped_budget;
    const summaryLine = () => {
        const blocked = client.metrics.blocked_429 + client.metrics.blocked_403 + client.metrics.captcha_redirects + client.metrics.captcha_bodies;
        return `${metrics.targets_ok + metrics.targets_no_ads}/${processedCount()} targets delivered (${metrics.targets_ok} advertising, ${metrics.targets_no_ads} no ads, ${metrics.targets_error} errors, ${metrics.targets_dropped_budget} not delivered at the charge limit), ${metrics.domain_rows_pushed + metrics.ad_rows_pushed} rows, ${client.metrics.requests} requests, ${blocked} blocked`;
    };

    let lastStatusAt = 0;
    const updateStatus = async (force = false) => {
        const now = Date.now();
        if (!force && now - lastStatusAt < 5_000) return;
        lastStatusAt = now;
        const msg = `${processedCount()}/${metrics.targets_total} targets: ${metrics.targets_ok} advertising, ${metrics.targets_no_ads} no ads, ${metrics.targets_error} errors; ${metrics.domain_rows_pushed + metrics.ad_rows_pushed} rows`;
        try {
            await Actor.setStatusMessage(msg);
        } catch {
            /* status messages are best-effort */
        }
    };

    const ctxFor = (): DeriveContext => ({ now: new Date(), activeWindowDays: input.activeWindowDays, region: input.region.label });

    /** Count an error and, in check/both mode, push an uncharged error row. */
    async function recordError(target: Target, message: string, pushRow: boolean): Promise<void> {
        errorsByMessage.set(message, (errorsByMessage.get(message) ?? 0) + 1);
        metrics.targets_error++;
        if (!wantCheck || !pushRow) return;
        try {
            await Actor.pushData(buildErrorRow(target, ctxFor(), message) satisfies CheckRow);
            metrics.domain_rows_pushed++;
        } catch (err) {
            log.warning(`Could not push the error row for ${target.value}: ${(err as Error).message}`);
        }
    }

    /**
     * Push rows and charge for them. Under pay-per-event the SDK trims the batch to the remaining budget,
     * pushes only that part and charges exactly what it pushed (so no row is ever charged without being delivered).
     */
    async function deliver(rows: (CheckRow | AdRow)[], eventName: string): Promise<{ pushed: number; limitReached: boolean }> {
        if (rows.length === 0) return { pushed: 0, limitReached: false };
        if (!isPpe) {
            await Actor.pushData(rows);
            return { pushed: rows.length, limitReached: false };
        }
        const result = await Actor.pushData(rows, eventName);
        if (eventName === EVENT_DOMAIN_CHECK) {
            remainingDomainChecks = result.chargeableWithinLimit[EVENT_DOMAIN_CHECK] ?? remainingDomainChecks;
        }
        return { pushed: result.chargedCount, limitReached: result.eventChargeLimitReached };
    }

    async function processTarget(target: Target): Promise<Outcome> {
        if (stop) return 'stopped';
        if (isPpe && wantCheck && remainingDomainChecks !== null && remainingDomainChecks <= 0) {
            metrics.charge_limit_reached = true;
            stop = true;
            return 'stopped';
        }

        let fetched: FetchTargetResult;
        try {
            fetched = await client.fetchTarget(target, { maxCreatives: plan.maxCreatives, shouldContinue: () => !stop });
        } catch (err) {
            if (err instanceof RateLimitFatalError || err instanceof TransportFatalError) {
                fatal = err;
                stop = true;
                await recordError(target, err.message, true);
                return 'error';
            }
            const message = describeError(err);
            log.warning(`Target ${target.value} failed: ${message}`);
            await recordError(target, message, true);
            return 'error';
        }
        if (fetched.stoppedEarly) {
            log.info(`${target.value}: run is stopping, partial result discarded (the target stays pending).`);
            return 'stopped';
        }

        const all = fetched.creatives;
        const sample = all.slice(0, input.sampleSize);
        const adCandidates = all.slice(0, plan.adRowLimit);
        const ctx = ctxFor();
        const stateKey = stateKeyFor(target);

        let diff: DiffResult | null = null;
        if (stateStore) {
            const previous = await stateStore.getValue<DomainState>(stateKey);
            // Track exactly the set that is delivered: the ad rows when ads are wanted, else the check sample.
            diff = diffCreatives(previous, wantAds ? adCandidates : sample, {
                now: ctx.now,
                activeWindowDays: input.activeWindowDays,
                region: input.region.label,
            });
            if (diff.regionMismatch) {
                log.warning(`${target.value}: stored snapshot was taken for another region; starting a fresh baseline.`);
            }
        }

        const checkRow: CheckRow | null = wantCheck
            ? buildCheckRow(target, { creatives: sample, adCountLow: fetched.adCountLow, adCountHigh: fetched.adCountHigh }, ctx, diff?.summary ?? null)
            : null;

        // Build ad rows and reserve their creative ids synchronously (no await between check and add).
        const adRows: AdRow[] = [];
        if (wantAds) {
            const newIds = diff ? new Set(diff.newIds) : null;
            for (const c of adCandidates) {
                if (chargedCreativeIds.has(c.creativeId)) continue;
                chargedCreativeIds.add(c.creativeId);
                adRows.push(buildAdRow(c, target, ctx, newIds ? (newIds.has(c.creativeId) ? 'new' : 'seen') : null));
            }
            if (diff) {
                for (const e of diff.ended) {
                    if (chargedCreativeIds.has(e.creativeId)) continue;
                    chargedCreativeIds.add(e.creativeId);
                    adRows.push(buildEndedAdRow(e.creativeId, e.stored, target, ctx));
                }
            }
        }
        const release = (rows: AdRow[]) => {
            for (const r of rows) chargedCreativeIds.delete(r.creative_id);
        };

        let checkDelivered = false;
        let adRowsDelivered = 0;
        try {
            if (checkRow) {
                const res = await deliver([checkRow], EVENT_DOMAIN_CHECK);
                if (res.pushed >= 1) {
                    checkDelivered = true;
                    metrics.domain_rows_pushed++;
                    if (isPpe) metrics.domain_checks_charged++;
                }
                if (res.limitReached) {
                    metrics.charge_limit_reached = true;
                    stop = true;
                }
            }
            if (adRows.length > 0 && (!checkRow || checkDelivered)) {
                const res = await deliver(adRows, EVENT_AD_ROW);
                adRowsDelivered = res.pushed;
                metrics.ad_rows_pushed += res.pushed;
                if (isPpe) metrics.ad_rows_charged += res.pushed;
                if (res.pushed < adRows.length) {
                    release(adRows.slice(res.pushed));
                    metrics.charge_limit_reached = true;
                    stop = true;
                } else if (res.limitReached) {
                    metrics.charge_limit_reached = true;
                    stop = true;
                }
            } else if (adRows.length > 0) {
                release(adRows);
            }
        } catch (err) {
            // Storage failure mid-delivery: rows that were not pushed were not charged (push precedes charge).
            release(adRows.slice(adRowsDelivered));
            const message = `delivery failed: ${(err as Error).message}`;
            log.exception(err as Error, `Delivery failed for ${target.value}`);
            await recordError(target, message, !checkDelivered);
            return 'error';
        }

        const anyDelivered = checkDelivered || adRowsDelivered > 0;
        const fullyDelivered = (!checkRow || checkDelivered) && adRowsDelivered === adRows.length;
        if (!anyDelivered) {
            metrics.targets_dropped_budget++;
            log.warning(`${target.value}: fetched but not delivered because the maximum total charge was reached.`);
            return 'dropped_budget';
        }
        if (!fullyDelivered) {
            log.warning(`${target.value}: ${adRows.length - adRowsDelivered} ad row(s) withheld at the maximum total charge.`);
        }

        // Post-delivery bookkeeping never turns a delivered target into an error.
        if (stateStore && diff && fullyDelivered) {
            try {
                await stateStore.setValue(stateKey, diff.nextState);
            } catch (err) {
                log.warning(`${target.value}: could not save the change-tracking snapshot: ${(err as Error).message}`);
            }
        }
        if (fetched.truncated && wantAds) {
            log.info(`${target.value}: stopped at ${all.length} creatives (maxAdsPerDomain); Google had more.`);
        }
        if (all.length > 0) {
            metrics.targets_ok++;
            return 'delivered';
        }
        metrics.targets_no_ads++;
        return 'no_ads';
    }

    const queue = input.targets.filter((t) => !doneTargets.has(targetKey(t)));
    if (queue.length === 0) {
        await persist();
        await Actor.exit(`All ${doneTargets.size} target(s) were already delivered before this restart; nothing left to do. ${summaryLine()}`);
        return;
    }

    const worker = async (): Promise<void> => {
        while (!stop) {
            const target = queue.shift();
            if (!target) return;
            let outcome: Outcome;
            try {
                outcome = await processTarget(target);
            } catch (err) {
                log.exception(err as Error, `Unexpected error on ${target.value}`);
                await recordError(target, `internal error: ${(err as Error).message}`, true);
                outcome = 'error';
            }
            // Only delivered targets are remembered; errored and undelivered ones are retried on a restart.
            if (outcome === 'delivered' || outcome === 'no_ads') {
                doneTargets.add(targetKey(target));
                if (stop) await persist();
            }
            await updateStatus();
        }
    };
    workersDone = Promise.all(Array.from({ length: Math.max(1, Math.min(input.maxConcurrency, queue.length)) }, () => worker())).then(
        () => undefined,
    );
    await workersDone;

    await persist();
    await updateStatus(true);

    const processed = processedCount();
    const succeeded = metrics.targets_ok + metrics.targets_no_ads;
    const rows = metrics.domain_rows_pushed + metrics.ad_rows_pushed;
    const summary = summaryLine();
    const [topError] = [...errorsByMessage.entries()].sort((a, b) => b[1] - a[1])[0] ?? ['unknown error'];
    log.info(summary, { metrics: snapshot() });

    if (fatal) {
        const f = fatal as RateLimitFatalError | TransportFatalError;
        const detail = f instanceof RateLimitFatalError ? `${f.consecutiveBlocked} consecutive blocked requests` : `${f.consecutiveFailures} consecutive transport failures`;
        await Actor.fail(`${f.message} (${detail}; ${summary})`);
        return;
    }
    if (succeeded === 0 && metrics.targets_error > 0) {
        await Actor.fail(`Every target failed, nothing was charged. Most common error: ${topError}. ${summary}`);
        return;
    }
    if (metrics.aborted) {
        await Actor.exit(`Aborted after ${processed}/${metrics.targets_total} targets. ${summary}`);
        return;
    }
    if (metrics.charge_limit_reached) {
        await Actor.exit(`Stopped at the maximum total charge after ${processed}/${metrics.targets_total} targets; ${metrics.targets_dropped_budget} fetched target(s) were not delivered. Raise the maximum total charge and resurrect the run to deliver the rest. ${summary}`);
        return;
    }
    if (rows === 0 && metrics.targets_error > 0) {
        await Actor.fail(`No rows delivered: ${metrics.targets_error}/${processed} targets failed (most common error: ${topError}), ${metrics.targets_no_ads} had no ads; nothing was charged. ${summary}`);
        return;
    }
    if (rows === 0) {
        await Actor.exit(`No ads found for any target; no rows and no charges. ${summary}`);
        return;
    }
    await Actor.exit(summary);
}

injectLocalPricingInfo();
await Actor.init();
try {
    await main();
} catch (err) {
    log.exception(err as Error, 'Actor failed');
    await Actor.fail(`Actor failed: ${(err as Error).message}`);
}
