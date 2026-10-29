# Handover: Google Ads Domain Checker

Built 2026-10-29 from `E:/Proj/apify/google-ads-domain-checker-spec.md`. Nothing has been pushed to Apify yet;
you create the account and push. This note covers how to push, how to set the two pricing events in the
Console, what to verify on the first platform runs, and what is still open.

## State of the project

| Item | Status |
| --- | --- |
| `npm run build` | passes (TypeScript 5.9, strict) |
| `npm test` | 107 tests pass (parser on 5 live fixtures, normalisation, regions, change detection, derivations, client retry policy, input) |
| `apify run` (local, no proxy, pay-per-event test mode) | verified in `check`, `ads` and `both` modes; charge counts match rows; the maximum-charge stop and the ended-creative path were exercised |
| Apify CLI | installed globally (`apify-cli 1.10.0`), not logged in |
| Platform runs | none yet |

Open questions resolved empirically with single plain requests on 2026-10-28 (see `.actor/CHANGELOG.md` and
`test/fixtures/README.md`): format enum (1 TEXT, 2 IMAGE, 3 VIDEO), ordering (lastShown descending, so
`last_seen` is exact), region filter (honoured server-side), advertiser-id filter (works anonymously, no domain
field in the response), pagination payload (top-level `"4"` cursor), no warm-up GET needed from a residential IP.

Still open (marked `TODO` in code and listed in the README limits): the ~1,000-creatives-per-query pagination
ceiling, whether got-scraping's TLS/header profile passes from Apify containers without a warm-up GET, whether
RESIDENTIAL proxies are available on the Free plan, the Chrome impersonation version ceiling, the ATC-specific
terms of service text, and the exact Store revenue share.

## 1. Push to Apify

```bash
apify login
```

```bash
cd E:/Proj/apify/google-ads-domain-checker && apify push
```

`apify push` uploads the source, builds the Docker image on the platform (multi-stage, Node 20, dev
dependencies only in the build stage) and tags it `latest`. The technical name is `google-ads-domain-check`
(from `.actor/actor.json`). The `storage/` folder, `node_modules/` and `dist/` are ignored by `.gitignore`;
`test/` and `scripts/` are excluded from the image by `.dockerignore` but still uploaded with the source, which
is fine.

If the build fails on the platform, the usual cause is the `npm install --include=dev` step; run
`npm ci && npm run build` locally first to confirm the lockfile is consistent.

## 2. Set the two pricing events in the Apify Console

Pay-per-event is configured in the Console, not in code. The `.actor/pay_per_event.json` file only mirrors the
events for local testing and documentation.

1. Open the actor in the Console, go to **Publication** (or **Settings > Monetization**, the tab name changes).
2. Choose **Pay per event** as the pricing model.
3. Add two events. The names must match the strings in `src/main.ts` exactly:

| Event name | Title | Price (USD) | Description |
| --- | --- | --- | --- |
| `domain-check` | Domain check | 0.003 | One summary row per checked domain (status advertising or no_ads_found). Never charged for Google-side errors. |
| `ad-row` | Ad row | 0.001 | One row per unique creative in ads or both mode, deduplicated by creative id within a run. |

4. Do **not** add an `actor-start` event: the listing promises no start fee.
5. Check the revenue share shown in the Console (the spec assumed 80 % minus platform usage) and the residential
   proxy price per GB; update the README pricing section if they differ.
6. Save, then publish to the Store with categories Lead generation, Marketing, Other.

Locally, `ACTOR_TEST_PAY_PER_EVENT=true` turns charging on; the SDK counts every event as $1 towards
`ACTOR_MAX_TOTAL_CHARGE_USD` regardless of the real price (it only uses the real prices for logging), so a limit
of `0.05` means "stop after the first event". That is SDK behaviour, not a bug in the actor.

## 3. Verify on the first platform runs

Run these from the Console before publishing, in this order.

1. **Prefilled input, defaults untouched** (what the Store's automated test will do): 3 domains, `check` mode,
   RESIDENTIAL proxy. Must finish in well under 5 minutes with 3 rows. If it fails with a proxy error, the
   account has no residential access: either upgrade or change the default `proxyConfiguration` in
   `.actor/input_schema.json` to `{ "useApifyProxy": true }` (datacenter) and say so in the README before
   publishing.
2. **5 domains, `check` mode, RESIDENTIAL.** Open the run's **Charges** tab: `domain-check` count must equal the
   number of rows with status `advertising` or `no_ads_found` (error rows are never charged). Open the
   key-value store record `OUTPUT`: `requests`, `blocked_429`, `captcha_redirects`, `bytes` and the charge
   counters are there. Record requests, blocked count and bytes per request for the README pricing section.
3. **Same 5 domains with the datacenter group** (`{ "useApifyProxy": true }`): document the difference
   (expect 429s and `error` rows). Confirm nothing was charged for error rows.
4. **`ads` mode on nike.com with `maxAdsPerDomain` 1000:** observe whether Google stops around 1,000 creatives
   (the unverified pagination ceiling), how many 429s occur, and the run cost. Update the README limits.
5. **Change tracking:** run `check` mode twice on the same 3 domains with `trackChanges: true`; the second run's
   `change_tracking.previous_run_at` must be the first run's time and `new_count` should be small.
6. If the very first request from the platform returns 403 or a captcha redirect while the same request works
   from a home IP, the TLS/header profile is the suspect: lower `maxVersion` in `createGotScrapingTransport`
   (`src/atc.ts`) or add a one-time warm-up `GET https://adstransparency.google.com/?region=anywhere` per session
   (the spec's fallback, ~2.5 MB per session, not implemented because it was not needed).

## 4. Local development

```bash
npm test
```

```bash
npm run build
```

Local run with the Apify CLI: edit `storage/key_value_stores/default/INPUT.json` (the folder is created by the
first run; use `"proxyConfiguration": { "useApifyProxy": false }` unless `APIFY_PROXY_PASSWORD` is set), then:

```bash
ACTOR_TEST_PAY_PER_EVENT=true apify run --purge
```

Results land in `storage/datasets/default/`, metrics in `storage/key_value_stores/default/OUTPUT.json`, and the
change-tracking snapshots in `storage/key_value_stores/google-ads-domain-check-state/`. `--purge` clears the
default stores but keeps the named state store.

Regenerate the region table after bumping `i18n-iso-countries`:

```bash
npm run generate:regions
```

## 5. Files

| Path | Purpose |
| --- | --- |
| `.actor/actor.json` | Actor metadata, name `google-ads-domain-check`, 256 MB default memory |
| `.actor/input_schema.json` | Input schema; `domains` is required and prefilled with nike.com, booking.com, shopify.com |
| `.actor/dataset_schema.json` | Two dataset views (domain checks, ad rows) for the Console |
| `.actor/pay_per_event.json` | The two events with prices, used only for local test mode |
| `.actor/CHANGELOG.md` | Google-side contract observations by date |
| `src/main.ts` | Orchestration: input, proxy, workers, charging, change tracking, OUTPUT metrics, exit codes |
| `src/atc.ts` | SearchCreatives client: payload, headers, sessions, pacing, retry policy, block detection |
| `src/parse.ts` | Numeric-field response parser |
| `src/derive.ts` | Check row and ad row derivations, Transparency Center URLs |
| `src/changes.ts` | New/ended diff against the key-value store snapshot |
| `src/input.ts` | Defaults, clamping, fetch plan |
| `src/normalize.ts` | Domain and advertiser-id normalisation |
| `src/regions.ts`, `src/regions-data.ts` | alpha-2 to 2000 + ISO numeric (generated) |
| `test/` | vitest suites and the live fixtures |
| `README.md` | Store listing |

## 6. Behaviour worth knowing before support questions arrive

- Error rows (`status: "error"`) are pushed in check/both mode so the buyer sees which domains failed, but they
  are never charged. A run where every target errored FAILS with the most common error in the status message.
- The run fails after 10 consecutive blocked requests across all sessions with the message
  "Google is rate-limiting every exit IP; rerun later or switch proxy group". Rows pushed before that stay in the
  dataset and stay charged.
- A run that hits the maximum total charge stops cleanly (exit code 0) with a status message saying so; the
  change-tracking snapshot is advanced only for targets whose rows were fully delivered.
- `ads` mode with no ads found anywhere succeeds with an empty dataset and an explicit status message; nothing is
  charged.
- The first change-tracking run is a baseline: every sampled creative is reported as `new` and
  `previous_run_at` is `null`.
- Creative ids are deduplicated across the whole run, so a creative reachable from two targets is charged once.
- `advertiserIds` targets put the AR id in the `domain` column (`target_type: "advertiser_id"`) because Google
  omits the domain field for that filter.

## 7. Monitoring to set up after publishing (spec section 8)

- A daily Schedule running `check` mode on nike.com, otpbank.hu and a no-ads domain; alert on run failure via the
  Schedule's notification settings.
- Answer every Store issue within 24 hours (the README promises it).
- Watch `https://api.apify.com/v2/acts/<your-username>~google-ads-domain-check` weekly for the 30-day success
  rate and user count, and scrapesage / solidcode / s-r for price changes.
