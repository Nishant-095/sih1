# IndiGo failure diagnosis — 9 October 2026

This records the earlier tests. The later persistent-worker implementation and successful headless batch are documented in [the current headless evidence report](headless-worker-2026-10-09.md). Some earlier run folders referenced here were subsequently deleted through the console; missing historical files must not be treated as currently available evidence.

## What failed

The batch `2026-10-09T12-21-06-431Z-77d31b` completed all 12 searches across BOM–MAA and DEL–HYD. The following batch, `2026-10-09T12-29-31-123Z-ff7a0a`, captured three DEL–BOM dates, then its 24 October fare POST returned HTTP 403. The preceding OPTIONS request returned 204. Twenty remaining searches were skipped, never submitted. Both batches used the same implementation fingerprint.

The route/date form was confirmed correctly. Chrome's `net::ERR_FAILED` followed the HTTP 403 because the rejection omitted the CORS allow-origin header. This is an access rejection, not an empty fare inventory or calendar failure. The exact airline rejection rule is unknown.

## Changes

- Keep the existing 20-second launch gap and add 20 seconds after a worker finishes. Previously, long searches consumed the launch gap and the next worker started about two seconds after completion.
- Rest for 90 seconds after six searches. Finish any active workers before starting that rest.
- Persist timing across batches and server restarts in `web-runs/.search-pacing.json`.
- Display scheduled start times and distinguish an attempted rejection from unsent searches.
- Preserve safe CDP request shape, payload hash/length, selected public response metadata, and hidden HTTP statuses. Raw authentication, cookie values, and request/rejection bodies are not saved by this diagnostic module. Existing page and airline fare evidence remains unchanged.
- Recommend visible Chrome. Preserve the stop on denial/CAPTCHA and do not automatically retry or rotate proxies after denial.

The pacing settings are conservative local choices, not published airline limits. Their effect on long-run rejection rates has not been established.

## Fresh live comparison

Connection: current Wi-Fi connection Wi-Fi. Network settings were unchanged. Normal Chrome with persistent dedicated profiles was used in both modes.

| Query | Browser/profile | Outcome | Verified fare records | Lowest displayed starting fare |
| --- | --- | --- | ---: | ---: |
| DEL–BOM, 24 Oct 2026 | Headless | Fare POST 403; next task skipped | 0 | Unavailable |
| DEL–BOM, 24 Oct 2026 | Visible | Fare POST 200; evidence passed | 67 | INR 6,373 |
| DEL–BOM, 23 Nov 2026 | Visible | Fare POST 200; evidence passed | 64 | INR 6,373 |

The 24 October request bodies were byte-identical (377 bytes, matching SHA-256). Recorded public headers, user agent/client hints, and cookie **names** also matched. Cookie values and all private headers were not compared. Different persistent profiles and browser modes were used, so this does not isolate browser mode from session state. It narrows the failure to the headless/profile path; it does not establish which site rule caused the rejection.

The rejected response had `Content-Type: text/html` and `Content-Length: 425`. Chrome did not expose its received body through CDP; the diagnostics explicitly record that limitation.

### Live evidence

- [Headless rejection](../web-runs/2026-10-09T12-47-15-726Z-24a32e/jobs.json): at 12:47 UTC, no fare response accepted.
- [24 October verified result](../web-runs/2026-10-09T12-48-58-669Z-43dc53/jobs.json): lowest fare collected at 12:49:33 UTC, flight 6E 353, INR 4,715 base + INR 1,658 included taxes/fees = INR 6,373.
- [23 November verified result](../web-runs/2026-10-09T12-51-46-871Z-d456dd/jobs.json): lowest fare collected at 12:52:19 UTC, flight 6E 395, same observed breakdown. This date required advancing beyond October in the calendar.

These are timestamped observations before possible convenience fees, not guaranteed future quotes. Earlier failures remain saved.

## Verification and remaining limit

30 targeted checks passed for pacing, restart persistence, concurrent-worker rest, diagnostics privacy, fault classification, and saved retries. A short local browser check confirmed the visible default, denial/skip notice, disabled denied retry, and verified fare rendering without page errors.

Visible Chrome succeeded on both fresh dates. Headless collection remains rejected in its current session. No claim is made that all external failures are solved or that long-run collection is failure-free.
