/**
 * Shared types for the Google Ads Domain Checker actor.
 */

export type Mode = 'check' | 'ads' | 'both';

export type AdFormat = 'TEXT' | 'IMAGE' | 'VIDEO' | 'UNKNOWN';

/** How the Ads Transparency Center previews a creative in the listing response. */
export type PreviewType = 'image' | 'rendered' | 'video' | 'none';

export type ChangeStatus = 'new' | 'seen' | 'ended';

/** One creative parsed from the numeric-field SearchCreatives response. */
export interface Creative {
    /** Field 1, e.g. "AR16735076323512287233". */
    advertiserId: string;
    /** Field 12. */
    advertiserName: string | null;
    /** Field 2, e.g. "CR04579281658410172417". */
    creativeId: string;
    /** Field 4 as received (1, 2, 3 or something new). */
    formatCode: number | null;
    /** Field 4 mapped: 1 = TEXT, 2 = IMAGE, 3 = VIDEO. Falls back to the preview when field 4 is missing. */
    format: AdFormat;
    /** Field 6.1, unix seconds. */
    firstShown: number | null;
    /** Field 7.1, unix seconds. */
    lastShown: number | null;
    /** Field 14. Absent when the search was by advertiser id. */
    domain: string | null;
    previewType: PreviewType;
    /** Archived image URL, YouTube URL, or the displayads-formats renderer URL. */
    previewUrl: string | null;
    /**
     * Field 13. Observed to track the number of days the creative was shown
     * (close to, but not always equal to, lastShown - firstShown). Meaning inferred, unverified,
     * therefore parsed but not emitted in dataset rows.
     */
    daysShownReported: number | null;
    /** Field 16, a boolean seen on agency-served (DV360) creatives. Meaning unknown. */
    flag16: boolean | null;
}

/** One page of the SearchCreatives listing. */
export interface SearchPage {
    creatives: Creative[];
    /** Field 2 of the response; null on the last page. */
    nextCursor: string | null;
    /** Field 4 of the response, approximate lower bound of the advertiser's ad count. */
    adCountLow: number | null;
    /** Field 5 of the response, approximate upper bound. */
    adCountHigh: number | null;
}

/** What the actor searches for. */
export type Target =
    | { kind: 'domain'; value: string }
    | { kind: 'advertiser'; value: string };

export interface ActorInput {
    domains?: string[];
    advertiserIds?: string[];
    mode?: Mode;
    region?: string;
    sampleSize?: number;
    maxAdsPerDomain?: number;
    activeWindowDays?: number;
    trackChanges?: boolean;
    stateStoreName?: string;
    proxyConfiguration?: {
        useApifyProxy?: boolean;
        apifyProxyGroups?: string[];
        apifyProxyCountry?: string;
        proxyUrls?: string[];
    };
    requestDelayMs?: number;
    maxConcurrency?: number;
}

export interface AdvertiserSummary {
    advertiser_id: string;
    advertiser_name: string | null;
    creatives_in_sample: number;
}

export interface FormatMix {
    text: number;
    image: number;
    video: number;
    unknown: number;
}

export interface ChangeTrackingSummary {
    new_creatives: string[];
    ended_creatives: string[];
    new_count: number;
    ended_count: number;
    previous_run_at: string | null;
}

/** One row per domain (check and both modes). */
export interface CheckRow {
    row_type: 'domain';
    domain: string;
    target_type: 'domain' | 'advertiser_id';
    region: string;
    checked_at: string;
    status: 'advertising' | 'no_ads_found' | 'error';
    advertiser_id: string | null;
    advertiser_name: string | null;
    additional_advertisers: AdvertiserSummary[];
    ad_count_low: number | null;
    ad_count_high: number | null;
    is_advertising_now: boolean;
    last_seen: string | null;
    days_since_last_ad: number | null;
    first_seen_in_sample: string | null;
    longest_running_days: number | null;
    longest_running_creative_id: string | null;
    active_creatives_in_sample: number;
    format_mix: FormatMix;
    sample_size: number;
    transparency_url: string | null;
    change_tracking: ChangeTrackingSummary | null;
    error: string | null;
}

/** One row per creative (ads and both modes). */
export interface AdRow {
    row_type: 'ad';
    creative_id: string;
    advertiser_id: string | null;
    advertiser_name: string | null;
    domain: string | null;
    format: AdFormat;
    first_shown: string | null;
    last_shown: string | null;
    days_shown: number | null;
    is_active_now: boolean;
    preview_url: string | null;
    preview_type: PreviewType;
    transparency_url: string | null;
    region: string;
    change_status: ChangeStatus | null;
    scraped_at: string;
}

/** Per-target snapshot kept in the named key-value store for change tracking. */
export interface StoredCreative {
    first_shown: string | null;
    last_shown: string | null;
    /** Unix seconds of last_shown, kept for day-precise "ended" decisions. */
    last_shown_ts?: number | null;
    advertiser_id?: string | null;
    advertiser_name?: string | null;
    format?: AdFormat;
    domain?: string | null;
}

export interface DomainState {
    run_at: string;
    region: string;
    creatives: Record<string, StoredCreative>;
}

export interface RunMetrics {
    requests: number;
    ok_responses: number;
    blocked_429: number;
    captcha_redirects: number;
    captcha_bodies: number;
    transient_errors: number;
    retries: number;
    bytes: number;
    targets_total: number;
    targets_ok: number;
    targets_no_ads: number;
    targets_error: number;
    /** Fetched, but nothing could be delivered because the maximum total charge was reached. */
    targets_dropped_budget: number;
    domain_rows_pushed: number;
    ad_rows_pushed: number;
    domain_checks_charged: number;
    ad_rows_charged: number;
    charge_limit_reached: boolean;
    aborted: boolean;
}
