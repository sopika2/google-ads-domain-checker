# Fixtures

Real responses from `POST https://adstransparency.google.com/anji/_/rpc/SearchService/SearchCreatives?authuser=`,
each captured with a single plain curl request (Chrome 131 desktop User-Agent, no proxy, no warm-up GET,
no cookies) from a Hungarian residential IP on 2026-10-28 23:12 UTC. Bodies are byte-for-byte as received.

| File | Request `f.req` | Result |
| --- | --- | --- |
| `nike-com.json` | `{"2":100,"3":{"12":{"1":"nike.com","2":true}},"7":{"1":1}}` | 100 creatives, cursor, ad count 50,000-60,000 |
| `otpbank-hu.json` | `{"2":100,"3":{"12":{"1":"otpbank.hu","2":true}},"7":{"1":1}}` | 100 creatives, cursor, ad count 1,000-2,000 |
| `no-ads.json` | `{"2":100,"3":{"12":{"1":"niijimasisters.com","2":true}},"7":{"1":1}}` | `{}` (HTTP 200, 2 bytes) |
| `nike-com-page2.json` | as `nike-com.json` plus `"4":"<cursor from nike-com.json field 2>"` at the top level | 100 further creatives, none overlapping page 1, lastShown still descending, new cursor |
| `advertiser-id-nike.json` | `{"2":100,"3":{"13":{"1":["AR16735076323512287233"]}},"7":{"1":1}}` | 100 creatives, cursor, ad count 8,000-9,000, no field 14 (domain) |

`nike-com.headers.txt` holds the response headers of the first request (HTTP 200, `application/json`, no anti-XSSI prefix).

Two further single probes were made but are not committed (one contained a sole trader's personal name):
region `HU` (`"8":[2348]`) on nike.com returned a different first page and ad count 2,000-3,000, and region `US`
(`"8":[2840]`) returned 8,000-9,000, so the region filter is honoured server-side.
