# Google Ads Domain Checker - Ads Transparency Center

Check any list of domains for live Google Ads and get one flat row per domain: the advertiser behind the domain, Google's ad-count range, the date an ad was last shown, how many days the longest ad has been running, the text / image / video mix and, between scheduled runs, which ads are new and which have ended. The data comes from Google's public Ads Transparency Center over plain HTTP: no browser, no login, no cookies. Pricing is pay-per-event, $3 per 1,000 domains checked and $1 per 1,000 ad rows, no start fee, and nothing is charged for a domain that Google blocked or that errored.

Three things set this actor apart from the ad-dump tools in the Store:

- **A bulk domain-list check priced per domain.** One flat row per domain with `is_advertising_now`, `last_seen`, `days_since_last_ad`, `longest_running_days`, the ad-count range, the format mix and a Transparency Center link. A domain with no ads is a result too (`status: "no_ads_found"`).
- **Run-to-run change detection.** Turn on `trackChanges`, put the actor on a Schedule, and every run reports the creatives that appeared and ended since the previous run. Free.
- **Cheap, honest flat ad rows.** $0.001 per creative with domain, dates, days shown, an active flag and a preview URL. Runs that Google blocks fail with a clear message instead of finishing green with an empty dataset.

## What you get

One real check row for `nike.com`, built from a live Ads Transparency Center response captured on 2026-10-28 and evaluated on 2026-10-29 with the default settings:

```json
{
  "row_type": "domain",
  "domain": "nike.com",
  "target_type": "domain",
  "region": "anywhere",
  "checked_at": "2026-10-29T08:15:42.000Z",
  "status": "advertising",
  "advertiser_id": "AR18378488041124659201",
  "advertiser_name": "Nike Retail BV",
  "additional_advertisers": [
    { "advertiser_id": "AR16735076323512287233", "advertiser_name": "Nike, Inc.", "creatives_in_sample": 32 },
    { "advertiser_id": "AR14612997888104464385", "advertiser_name": "NIKE GLOBAL TRADING B.V. SINGAPORE BRANCH", "creatives_in_sample": 8 },
    { "advertiser_id": "AR09595561223982678017", "advertiser_name": "M Media Group Pty Ltd", "creatives_in_sample": 3 },
    { "advertiser_id": "AR06365026152670560257", "advertiser_name": "WPP MEDIA MANAGEMENT", "creatives_in_sample": 3 },
    { "advertiser_id": "AR03005330488370921473", "advertiser_name": "NIKE GLOBAL TRADING B.V. SINGAPORE BRANCH", "creatives_in_sample": 1 },
    { "advertiser_id": "AR01437837420136497153", "advertiser_name": "株式会社ナイキジャパン", "creatives_in_sample": 1 },
    { "advertiser_id": "AR11154049584043393025", "advertiser_name": "INITIATIVE MEDIA B.V.", "creatives_in_sample": 1 }
  ],
  "ad_count_low": 50000,
  "ad_count_high": 60000,
  "is_advertising_now": true,
  "last_seen": "2026-10-28",
  "days_since_last_ad": 0,
  "first_seen_in_sample": "2021-10-25",
  "longest_running_days": 1829,
  "longest_running_creative_id": "CR06958479822821523457",
  "active_creatives_in_sample": 100,
  "format_mix": { "text": 85, "image": 10, "video": 5, "unknown": 0 },
  "sample_size": 100,
  "transparency_url": "https://adstransparency.google.com/advertiser/AR18378488041124659201?region=anywhere",
  "change_tracking": null,
  "error": null
}
```

Reading it: Google holds 50,000 to 60,000 ads for `nike.com`. Of the 100 most recently shown creatives, 51 belong to "Nike Retail BV", the primary advertiser; seven further Nike entities and media agencies share the domain. All 100 were shown within the last 7 days, so the domain is advertising right now.

One real ad row (`mode: "ads"` or `"both"`), the first creative of the same response:

```json
{
  "row_type": "ad",
  "creative_id": "CR04579281658410172417",
  "advertiser_id": "AR16735076323512287233",
  "advertiser_name": "Nike, Inc.",
  "domain": "nike.com",
  "format": "TEXT",
  "first_shown": "2023-11-17",
  "last_shown": "2026-10-28",
  "days_shown": 1076,
  "is_active_now": true,
  "preview_url": "https://tpc.googlesyndication.com/archive/simgad/13335954786324240689",
  "preview_type": "image",
  "transparency_url": "https://adstransparency.google.com/advertiser/AR16735076323512287233/creative/CR04579281658410172417?region=anywhere",
  "region": "anywhere",
  "change_status": null,
  "scraped_at": "2026-10-29T08:15:42.000Z"
}
```

A `TEXT` creative with an image preview is normal: Google archives text ads as screenshots, so `format` says what kind of ad it is and `preview_type` what kind of preview Google serves. Every row lands in the run's dataset, downloadable as JSON, CSV, Excel or XML or pulled through the Apify API and integrations.

## Who it is for: is this company running Google Ads?

**Lead qualification for agencies.** Run your prospect list in `check` mode and sort by `is_advertising_now`, `ad_count_low` and `days_since_last_ad`. A domain with 2,000 ads and one shown yesterday is a live Google Ads account with budget behind it; `no_ads_found` is a cold pitch for paid search. `longest_running_days` and `format_mix` show whether they run evergreen text campaigns, display banners or YouTube video.

**CRM enrichment.** Feed a bulk list (up to 10,000 domains per run), get exactly one flat row per domain and join it to your CRM on the `domain` column. Full URLs from a website field are accepted and normalised to a bare host, so `https://www.Example.com/pricing?x=1` and `example.com` become one target.

**Competitor monitoring on a Schedule.** Run the competitor domains with `trackChanges: true` from an Apify Schedule, and each run's `change_tracking` block lists the creatives that are new since the last run and the ones that have ended. In `both` mode they also arrive as ad rows with `change_status` set, so a webhook can forward just the changes.

## How it works with the Google Ads Transparency Center

The actor sends the same listing request to the Ads Transparency Center that the public website sends when you search for a domain. One request returns up to 100 creatives with advertiser, creative id, format, first and last shown dates, a preview and Google's approximate ad count. A domain check is one request; an `ads` run pages 100 at a time until `maxAdsPerDomain` or the last page.

Google throttles each exit IP after a few dozen requests (HTTP 429, then a redirect to a reCAPTCHA page) and blocks datacenter IPs much faster than residential ones. So the actor uses Apify residential proxies by default, opens one sticky proxy session per domain so a multi-page listing stays on one IP, paces every session at one request per second, and runs four domains in parallel by default.

When Google blocks a request, the actor discards that session, pauses (2 seconds, then 5 seconds), opens a fresh one and retries the same page, up to three attempts. If ten requests in a row are blocked across all sessions, the run fails with a clear message rather than quietly producing an empty dataset. A domain that still fails after retries gets a `status: "error"` row and is not charged.

## Input

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `domains` | list of strings | prefilled with `nike.com`, `booking.com`, `shopify.com` | Domains to check, one per line. Full URLs are accepted: scheme, `www.` prefix, path and query are stripped, the host is lower-cased and duplicates are removed. Required, but may be empty when `advertiserIds` is given. Soft cap 10,000 per run. |
| `advertiserIds` | list of strings | `[]` | Experimental. Google advertiser IDs (`AR` followed by digits), checked in addition to the domains. Each ID is its own target: its rows carry the ID in the `domain` column and the advertiser id and name from Google. Verified working anonymously on 2026-10-28, but one vendor reported HTTP 400 on this filter. |
| `mode` | `check`, `ads` or `both` | `check` | `check` = one summary row per domain (event `domain-check`). `ads` = one row per creative (event `ad-row`). `both` = both in one dataset; `row_type` tells them apart. |
| `region` | string | `anywhere` | ISO 3166-1 alpha-2 country code (`US`, `GB`, `DE`, `HU`) to restrict results to ads shown in that country, or `anywhere`. Ad counts and samples differ by region. |
| `sampleSize` | integer, 20 to 500 | `100` | Most-recent creatives read per domain in `check` mode for the sample-based fields and change detection. 100 creatives = 1 request. |
| `maxAdsPerDomain` | integer, 1 to 5,000 | `500` | Pagination cap per domain in `ads` and `both` modes, 100 creatives per request. |
| `activeWindowDays` | integer, 1 to 400 | `7` | A creative or advertiser counts as active now when its last-shown date is within this many days of the run. Also the threshold for calling a creative ended. |
| `trackChanges` | boolean | `false` | Remember the creatives seen per domain in a named key-value store and report new and ended creatives on the next run. Free. |
| `stateStoreName` | string, 3 to 63 letters, digits or hyphens | `google-ads-domain-check-state` | Key-value store that holds the per-domain snapshot for change tracking. Use a different name per monitoring list. |
| `proxyConfiguration` | proxy object | Apify Proxy, group `RESIDENTIAL` | Google rate-limits datacenter IPs quickly, so residential is the default. Switch to datacenter at your own risk: blocked domains come back as `status: "error"` and are never charged. |
| `requestDelayMs` | integer, 250 to 10,000 | `1000` | Minimum pause between two requests on the same proxy session. 1,000 ms (one request per second per IP) is the known-safe rate. |
| `maxConcurrency` | integer, 1 to 8 | `4` | Targets fetched at the same time, each on its own proxy session. 4 is the known-safe default; higher values risk a pool-wide block. |

To check only advertiser IDs, pass `"domains": []` together with `advertiserIds`. Entries that are not a valid host or `AR` id are skipped with a warning and never charged. Beyond the soft cap of 10,000 targets the rest of the list is dropped with a warning; split larger lists across runs.

A minimal input for a monitoring run:

```json
{
  "domains": ["nike.com", "https://www.adidas.com/us", "puma.com"],
  "mode": "both",
  "region": "US",
  "trackChanges": true,
  "stateStoreName": "sportswear-us"
}
```

## Output

`check` mode writes one row per domain (`row_type: "domain"`), `ads` mode one row per creative (`row_type: "ad"`), and `both` writes both into the same dataset, so filter on `row_type` when you export. Two kinds of fields appear in a check row and it matters which is which:

- **Exact fields** come from Google or from the newest creatives. Google returns creatives ordered by last-shown date descending (verified on two consecutive pages on 2026-10-28), so the newest creative is always in the sample: `last_seen`, `days_since_last_ad` and `is_advertising_now` are exact whatever the `sampleSize`. `ad_count_low` and `ad_count_high` are Google's own approximate range for the search, not derived from the sample.
- **Sample-based fields** describe only the `sampleSize` most recent creatives (100 by default): `first_seen_in_sample`, `longest_running_days`, `longest_running_creative_id`, `active_creatives_in_sample`, `format_mix`, `additional_advertisers` and the choice of primary advertiser. For an advertiser with 50,000 ads, "first seen in sample" is not "first ever advertised". Raise `sampleSize` (up to 500) for a wider view.

### Check rows (`row_type: "domain"`)

| Field | Meaning |
| --- | --- |
| `row_type` | Always `domain`. |
| `domain` | The normalised domain that was checked, or the advertiser ID for `advertiserIds` targets. Join key for your list. |
| `target_type` | `domain` or `advertiser_id`. |
| `region` | The region the check was made for (`anywhere` or the upper-cased country code). |
| `checked_at` | ISO 8601 timestamp of the check. |
| `status` | `advertising`, `no_ads_found` (Google returned nothing) or `error` (see Failure behaviour). |
| `advertiser_id` | Primary advertiser: the one with the most creatives in the sample. For advertiser-ID targets, the ID you passed. Sample-based choice. |
| `advertiser_name` | The primary advertiser's name as Google shows it. |
| `additional_advertisers` | Every other advertiser in the sample, most creatives first, each as `advertiser_id`, `advertiser_name`, `creatives_in_sample`. Sample-based. |
| `ad_count_low`, `ad_count_high` | Google's approximate ad-count range for this search. Exact as Google reports it; `null` when no ads were found. |
| `is_advertising_now` | `true` when any creative was shown within `activeWindowDays` of the run. Exact. |
| `last_seen` | ISO date of the most recently shown creative. Exact. |
| `days_since_last_ad` | Whole days between `last_seen` and the check. Exact. |
| `first_seen_in_sample` | Earliest first-shown date among the sampled creatives. Sample-based. `2021-10-25` is the start of Google's archive: a creative with that date was already running when the Transparency Center began recording, so read it as "at least since then". |
| `longest_running_days` | Longest span in whole days between first and last shown for a single sampled creative. Sample-based, and capped by the archive start: large advertisers often show 1,829 days or more, meaning the ad predates Google's records. |
| `longest_running_creative_id` | The creative behind `longest_running_days`. Sample-based. |
| `active_creatives_in_sample` | How many sampled creatives were shown within `activeWindowDays`. Sample-based. |
| `format_mix` | Counts of `text`, `image`, `video` and `unknown` creatives in the sample. Sample-based. |
| `sample_size` | Creatives actually read (at most `sampleSize`). |
| `transparency_url` | Link to the primary advertiser's Transparency Center page, or to the domain search when no ads were found. |
| `change_tracking` | `null` unless `trackChanges` is on; otherwise `new_creatives`, `ended_creatives` (lists of ids), `new_count`, `ended_count`, `previous_run_at`. |
| `error` | `null` unless `status` is `error`; then a short reason. |

### Ad rows (`row_type: "ad"`)

| Field | Meaning |
| --- | --- |
| `row_type` | Always `ad`. |
| `creative_id` | Google's creative id (`CR...`). Unique within a run. |
| `advertiser_id` | The advertiser's id (`AR...`). |
| `advertiser_name` | The advertiser's name as Google shows it. |
| `domain` | The domain the creative was found for. `null` for advertiser-ID targets, because Google omits the domain in that search. |
| `format` | `TEXT`, `IMAGE`, `VIDEO` or `UNKNOWN` (Google's format codes 1 / 2 / 3, verified 2026-10-28). |
| `first_shown` | ISO date the creative was first shown. |
| `last_shown` | ISO date the creative was last shown. |
| `days_shown` | Whole days between `first_shown` and `last_shown`. |
| `is_active_now` | `true` when `last_shown` is within `activeWindowDays` of the run. |
| `preview_url` | Archived image URL for banners and text-ad screenshots, or Google's rendered-preview URL for video and responsive ads (a YouTube watch URL when Google exposes a video id, which the listing did not do in the captured samples). `null` for ended rows. |
| `preview_type` | `image`, `video`, `rendered` or `none`. |
| `transparency_url` | Link to this creative in the Ads Transparency Center. |
| `region` | The region the run was made for. |
| `change_status` | `null` unless `trackChanges` is on; otherwise `new`, `seen` or `ended`. |
| `scraped_at` | ISO 8601 timestamp of the run. |

## Change detection between runs: competitor Google Ads monitoring

Set `trackChanges: true` and the actor keeps a snapshot per domain in a named key-value store (`stateStoreName`) with the creatives it has seen and their first and last shown dates. Every later run compares the fresh result against that snapshot:

- **New**: a creative in the current result that was not in the snapshot.
- **Ended**: a creative in the snapshot that is absent from the current result **and** whose last-shown date is older than `activeWindowDays`. A creative that merely dropped out of the sample while still recently shown is carried forward unchanged and resolved on a later run. This is deliberately conservative because `check` mode reads only the latest `sampleSize` creatives.
- Everything else is **seen**.

The first run with a given store is a baseline: every sampled creative is reported as new and `previous_run_at` is `null`.

- In `check` and `both` mode the check row's `change_tracking` block lists `new_creatives`, `ended_creatives`, their counts and `previous_run_at`. In `check` mode the snapshot covers the `sampleSize` latest creatives.
- In `ads` and `both` mode every ad row carries `change_status` (`new` or `seen`), and ended creatives are emitted as extra ad rows with `change_status: "ended"`, `is_active_now: false` and the dates from the snapshot. The snapshot then covers every creative fetched up to `maxAdsPerDomain`. Ended rows are charged as ad rows.

The snapshot is advanced only after the rows for that domain were delivered, so a domain that errored, or a run that hit its charge limit halfway, keeps its previous baseline.

Run the actor from an Apify Schedule so the interval is regular; keep `sampleSize`, `region` and `mode` stable between runs of the same store; and use a different `stateStoreName` per monitoring list and per region, because the snapshot is keyed by domain. Change tracking is free.

## Pricing and cost transparency

The actor is pay-per-event. You pay for rows delivered: no start fee, no per-run minimum, no charge for errors.

| Event | Price | When it is charged |
| --- | --- | --- |
| `domain-check` | $0.003 per row | Once per domain in `check` and `both` mode, for `advertising` and `no_ads_found` results. Never for `error` rows. |
| `ad-row` | $0.001 per row | Once per unique creative in `ads` and `both` mode, deduplicated by creative id within the run. Ended creatives from change tracking count as ad rows. |

Worked examples:

- 1,000 domains in `check` mode = 1,000 x $0.003 = **$3.00**, no matter how many of them have no ads.
- 10,000 ad rows in `ads` mode = 10,000 x $0.001 = **$10.00**.
- 100 domains in `both` mode, each with at least 500 ads and the default `maxAdsPerDomain` of 500 = 100 x $0.003 + 50,000 x $0.001 = **$50.30**, so set `maxAdsPerDomain` to what you need.
- The $5 of free credit on an Apify Free plan covers about **1,600 domain checks** or **5,000 ad rows**.

Never charged: `status: "error"` rows (Google-side blocks after retries, rejected requests, network failures), invalid list entries, domains dropped by the 10,000 soft cap, and anything after your maximum total charge, where the run stops cleanly without writing an uncharged row.

What it costs to produce: a domain check is one request of roughly 40 to 50 KB through residential proxy (about $0.0003 at the $8 per GB residential rate shown on Apify's pricing page; confirm your plan's rate in the Console) plus about 3 seconds of a 256 MB container (about $0.0001), roughly **$0.0004 in total**. An ad row costs about $0.000003 in proxy traffic because 100 rows arrive per request. The rest is margin that funds maintenance against Google-side changes and the 24-hour support promise below. Proxy and compute are included in the per-event price.

Measured on the first platform run (2026-10-29, `check` mode, 3 domains, residential proxy, 256 MB): 3 requests, 0 blocked, 50 KB per request, 7 seconds, **$0.0008 total platform cost**, so about $0.00027 per domain. Figures from larger runs will be added here as they come in.

## Limits and known gaps of this Google Ads checker

- **Google's archive starts on 2021-10-25.** Creatives already live on that date carry it as their first-shown date, so `first_seen_in_sample` and `longest_running_days` are lower bounds for long-running advertisers, not the true campaign age.
- **Sample-based fields are sample-based.** `first_seen_in_sample`, `longest_running_days`, `longest_running_creative_id`, `active_creatives_in_sample`, `format_mix`, `additional_advertisers` and the primary-advertiser choice describe the latest `sampleSize` creatives only; for large advertisers (Nike has 50,000 to 60,000 ads) they are approximations. `last_seen`, `days_since_last_ad`, `is_advertising_now` and the ad-count range are exact.
- **Retention.** Google removes non-political ads about 12 to 13 months after they stop showing, so a brand that paused for longer looks like a new advertiser. Ads that are still running keep their full history: the `nike.com` sample above contains creatives first shown in October 2021.
- **Age-restricted ads are invisible.** Google hides them from signed-out visitors, and this actor is always signed out; an advertiser whose ads are all age-restricted can come back as `no_ads_found`.
- **Google throttles per IP.** After a few dozen requests from one IP Google answers HTTP 429 and then redirects to a reCAPTCHA page; only a new exit IP clears it, and datacenter proxies get blocked fast, which is why `RESIDENTIAL` is the default. Whether residential proxies are available on the Apify Free plan, and at what per-GB price, is unverified: verify in your Console. Without residential, use the datacenter group and expect `error` rows at volume (never charged).
- **Possible pagination ceiling.** Some vendors report that Google stops returning results around 1,000 creatives per query; others have fetched far more. This is unverified (TODO: verify on the first platform run). If you hit it with `maxAdsPerDomain` above 1,000, split the run by `region`.
- **EU-only fields are not available.** The impressions, audience and platform breakdowns Google shows for ads served in the EU are not part of this actor.
- **No ad copy.** Headlines and descriptions are not extracted; you get format, dates, preview URL and the link to the creative.
- **Region filter semantics are only partly verified.** Verified server-side on 2026-10-28 for `anywhere`, `US` and `HU` on `nike.com` (50 to 60 thousand, 8 to 9 thousand and 2 to 3 thousand ads); other countries have not been individually checked.
- **Advertiser names can be personal data.** A sole trader's verified advertiser name is often the person's own name, so `advertiser_name` can be a natural person's name (one appeared in a test sample); you are responsible for your GDPR basis for storing and using it.
- **Experimental advertiser-ID search.** If Google rejects the `advertiserIds` filter (one vendor reports HTTP 400), those targets come back as `error` rows and are not charged.

## Failure behaviour

The actor would rather fail than hand you an empty dataset that looks like a result.

- **Per domain.** A domain that Google blocked after three attempts, rejected, or that failed on the network gets a check row with `status: "error"`, empty data fields and a short reason in `error` (for example `blocked by Google after retries (http_429, HTTP 429)`). Error rows are never charged. In `ads` mode no row is written for an errored domain; the reason is in the log.
- **Pool-wide rate limiting.** After 10 consecutive blocked requests across all sessions the run fails with `Google is rate-limiting every exit IP; rerun later or switch proxy group`. Domains processed before the stop have been delivered and charged; the rest were not touched, and change tracking carries on from the last delivered state.
- **Every target errored.** The run fails with `Every target failed, nothing was charged` and the most common error, so a bad proxy setup or a Google-side change is a red run, not a green run with nothing in it.
- **Nothing found.** A run in which no target had ads succeeds with an honest status message. In `check` and `both` mode the `no_ads_found` rows are delivered and charged; in `ads` mode there are no rows and no charges.
- **Charge limit reached.** The run exits cleanly with `Stopped at the maximum total charge` and the count of processed targets.
- **Aborted runs.** In-flight requests finish, the counters are saved, and the run exits with the number of targets processed.
- **Migrated runs.** When Apify moves the run to another server it restarts automatically; the actor remembers which targets were already delivered and charged and skips them, so a migration never charges a domain twice.

Every run writes an `OUTPUT` record to its default key-value store with the request, block and charge counters: requests, OK responses, 429 blocks, reCAPTCHA redirects, retries, bytes, targets by outcome, rows pushed and charged per event, and whether the charge limit was reached or the run aborted.

## Changelog

**0.1.0 (2026-10-29)**: initial release with `check`, `ads` and `both` modes, run-to-run change detection, two pay-per-event events (`domain-check` $0.003, `ad-row` $0.001) and no start fee. Verified against live Ads Transparency Center responses captured on 2026-10-28: results are ordered by last-shown date descending (so `last_seen` and `is_advertising_now` from the sample are exact); format codes 1 / 2 / 3 map to TEXT / IMAGE / VIDEO; the advertiser-ID filter works anonymously and omits the domain field; the region filter is honoured server-side (nike.com: anywhere 50 to 60 thousand ads, US 8 to 9 thousand, HU 2 to 3 thousand); a domain with no ads returns an empty response with HTTP 200; no warm-up page load was needed from a residential IP. Later Google-side changes are recorded here with the date they were verified.

## Support

Issues reported in this actor's **Issues** tab on the Apify Store are answered within 24 hours. Include the run ID and, if the problem is specific to a target, one example domain. When Google changes the Transparency Center, the actor is updated and the change is noted in the changelog.

## Legal and fair use

All data comes from Google's public Ads Transparency Center, published so that anyone can see who is advertising and with what. The actor reads the same listing a signed-out visitor sees and does not attempt to bypass bot checks or CAPTCHAs: a CAPTCHA response is treated as a block and retried on a different IP or given up.

Use the results responsibly. Advertiser names can belong to sole traders and are then personal data; you are responsible for a lawful basis for storing and using them and for complying with Google's terms and the laws that apply to you. This actor is not affiliated with or endorsed by Google.
