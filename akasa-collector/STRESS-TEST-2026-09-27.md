# Akasa live stress test — 27 September 2026

This report records direct website observations, not guaranteed future prices. Each fare below passed flight, route, date, time, displayed-price, airline-response, and saved-page verification. Prices are the starting fares shown by Akasa; the response's additional WFE is recorded separately.

## Prospective batch

- Run: `runs/2026-09-27T14-07-49-280Z-7ecdb7/`
- Browser: headless Chrome, persistent profile, sequential searches, minimum 20 seconds between starts, one bounded retry per failure.
- Routes: DEL–BOM and DEL–BLR. Dates: T+1, T+5, T+9, T+15, T+30, T+45 from 27 September in India.
- Original outcome: **10 of 12 searches verified**. Both T+1 searches failed before submission because the collector compared Akasa's `Sep` with Node's `Sept` date label. Their page evidence shows the correct selected date. They remain recorded as failures in the original run.

| Travel date | DEL–BOM flights / cheapest displayed | DEL–BLR flights / cheapest displayed |
| --- | ---: | ---: |
| 28 Sep 2026 | 7 / ₹6,530 (verified retry) | 5 / ₹8,829 (verified retry) |
| 2 Oct 2026 | 6 / ₹6,530 | 5 / ₹8,829 |
| 6 Oct 2026 | 7 / ₹6,530 | 4 / ₹8,829 |
| 12 Oct 2026 | 6 / ₹6,530 | 5 / ₹8,829 |
| 27 Oct 2026 | 7 / ₹6,530 | 5 / ₹9,680 |
| 11 Nov 2026 | 6 / ₹8,683 | 6 / ₹11,654 |

## Correction and verification

- `matchesDateInput` now compares calendar day, month abbreviation, and year, accepting both `Sep` and `Sept` without accepting another date. Targeted regression test passed.
- DEL–BOM 28 Sep was retried via its own UI button: `runs/2026-09-27T14-13-01-326Z-9ba6d9/`, 7 verified fares.
- DEL–BLR 28 Sep was retried via its own UI button: `runs/2026-09-27T14-13-47-752Z-0c75ee/`, 5 verified fares.
- All 12 unique route/date pairs therefore have at least one verified live observation, across the original and corrected builds. **This is not a 12/12 single-build success claim.** The manifests preserve distinct `sourceFingerprint` values.
- The evidence verifier was strengthened to check the result page, screenshot, form page, response, and individual row hashes for new runs. A new BOM–BLR live run passed: `runs/2026-09-27T14-15-36-474Z-74ba72/`, 6 fares. Altering one byte of a temporary screenshot copy made verification fail with `Result screenshot hash mismatch`; the original evidence was not changed.
- The local page shows zero fare rows under failed or partial searches. It labels older failed cards when a later retry succeeds and links to that successful run.

## Checks and limits

- `npm test`: 3 passed.
- Strict UI audit: 0 findings.
- Final localhost page: HTTP 200, mobile viewport has no horizontal overflow or page script errors.
- The live site, network, future fare inventory, and an external proxy can still fail. This test did not use an external proxy, and it does not establish a multi-day reliability percentage.
