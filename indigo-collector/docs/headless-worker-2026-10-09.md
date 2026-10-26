# Persistent headless Chrome — live evidence, 9 October 2026

## Result

The console batch `2026-10-09T13-37-48-466Z-591799` completed **4/4 ordinary live headless searches**, capturing **259 verified fare records**. Each query passed the page, screenshot, matching airline response, breakdown, and inventory-coverage verifier. All four flight-search responses returned **HTTP 200**. No fixtures or cached fares were substituted.

Collected between **19:08 and 19:11 IST on 9 October 2026**. The network was left unchanged. Batch started `2026-10-09T13:37:48.467Z` and finished `2026-10-09T13:41:17.507Z` (UTC).

| Route | Travel date | Verified records | Lowest observed itinerary | Base + included taxes/fees | Total INR |
|---|---|---:|---|---:|---:|
| DEL–BOM | 2026-10-10 | 68 | 6E 449 | 4,715 + 1,658 | 6,373 |
| DEL–BOM | 2026-11-23 | 65 | 6E 395 | 4,715 + 1,658 | 6,373 |
| DEL–BLR | 2026-10-10 | 64 | 6E 6054 | 6,948 + 2,091 | 9,039 |
| DEL–BLR | 2026-11-23 | 62 | 6E 2303 · 6E 887 | 8,665 + 2,308 | 10,973 |

Quotes are timestamped displayed starting fares, before any possible convenience fee. The November DEL–BLR minimum is a connecting itinerary. Nearby-airport rows were excluded from these route counts.

## What changed

- One ordinary installed Chrome process, browser context, and tab stay alive per worker throughout a console batch. Each new query still navigates through the booking form and saves its own evidence.
- Both browser modes use the same dedicated profile configuration. The existing `.session/web-agents/headed/agent-N` directory name is historical; the old headless profile was kept, not erased.
- Submission waits for document completion and pending booking token validation/refresh requests. Unrelated advertising requests do not hold up collection.
- IPC task identifiers keep events and results attached to the correct query. Per-query listeners and CDP observers are detached without closing the shared browser.
- A denied worker refuses later commands. Cancellation, startup failure evidence, worker shutdown, persisted pacing, and shared browser admission remain enforced.
- Diagnostic mode comparisons are explicitly excluded from production reliability statistics.

## Browser reuse proof

Every query saved Chrome PID **185041**, worker session **6f6cd41e-b4c3-461e-ac5d-58a9fa6a6edd**, and consecutive search numbers **1, 2, 3, 4**. Searches 2–4 record `reused: true`. The browser exited after completion. All four searches used implementation fingerprint:

```text
4d8edf10ec4027f8687d3254347a04cf87ae1fc054164bc2a6d55cbb339ea73d
```

## Controlled diagnosis

A separate bounded comparison ran DEL–BOM for 24 October once in each browser mode, starting from copies of the same profile snapshot. **Headless: 67 verified records; visible: 67 verified records.** Both used the same diagnostic source fingerprint. The headless GPU renderer was SwiftShader and the visible renderer was AMD Vega 8; both requests were accepted, so changing GPU behavior was not supported by this evidence.

A further control used the previously denied headless profile with the new implementation. It also captured **67 verified records**. Consequently, these results do not establish a damaged profile, headless detection, or a specific airline rejection rule as the cause of the earlier HTTP 403. They establish that the new headless path collected live fares successfully during this test. All three diagnostic runs are marked and excluded from production reliability measurements.

## Checks and saved evidence

- **50 targeted local checks passed:** browser reuse, booking readiness, denial stops, cancellation, error recording, evidence integrity, pacing, and shared admission. The complete test suite was not run.
- Browser smoke check: console displayed **Complete · 4/4 · 259 fares**, four verified cards and 259 fare rows; no JavaScript page errors.
- The existing combined dashboard ingested these live observations without a separate integration patch; its page smoke check had no JavaScript page errors.
- [Production run and step logs](../web-runs/2026-10-09T13-37-48-466Z-591799/jobs.json)
- [Machine-readable verification, per-query paths, prices and evidence hashes](../web-runs/2026-10-09T13-37-48-466Z-591799/headless-validation.json)
- [Console screenshot](../web-runs/2026-10-09T13-37-48-466Z-591799/console-smoke.png)
- [Dashboard screenshot](../web-runs/2026-10-09T13-37-48-466Z-591799/dashboard-smoke.png)
- [Paired diagnostic report](../runs/mode-comparison-2026-10-09T13-29-43-089Z-ba2667/comparison.json)
- [Old-profile control](../runs/old-profile-control/2026-10-09T13-33-22-481Z-553680/manifest.json)

**Acceptance boundary:** four successful production searches on one day verify this batch. They do not establish the historical 20-search, three-day reliability gate or guarantee acceptance of every future request. HTTP 403, CAPTCHA and rate limiting still stop collection rather than becoming sold-out results.
