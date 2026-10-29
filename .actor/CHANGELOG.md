# Changelog

All Google-side contract observations (field numbers, filter semantics, throttling) are recorded here with the date they were verified.

## 0.1.0 - 2026-10-29

- Initial release: `check`, `ads` and `both` modes, run-to-run change detection, two pay-per-event events (`domain-check` $0.003, `ad-row` $0.001), no start fee.
- Verified against live `SearchCreatives` responses captured 2026-10-28:
  - results are ordered by `lastShown` descending (so `last_seen` and `is_advertising_now` from the sample are exact);
  - format enum 1 = TEXT, 2 = IMAGE, 3 = VIDEO (image banners carry standard 300x250 / 300x600 sizes; text ads are archived as fixed-width screenshots);
  - the advertiser-id filter `{"3":{"13":{"1":["AR..."]}}}` works anonymously and omits the domain field (14);
  - the region filter `"8":[2000 + ISO numeric]` is honoured server-side (nike.com: anywhere 50-60K ads, US 8-9K, HU 2-3K);
  - a domain with no ads returns an empty object `{}` with HTTP 200;
  - the response has no anti-XSSI prefix and no warm-up GET was needed from a residential IP.
