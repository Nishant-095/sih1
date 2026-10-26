# Troubleshooting and recorded failure history

This is a short, sanitized summary of known outcomes from development runs. It
is not a promise that a later run will succeed. Exact run logs, screenshots,
browser profiles, cookies, and airline response bodies are stored locally and
are deliberately not included in this repository because they can contain
session or travel-search data.

## Read the outcome first

| Outcome | What it means | What to do |
| --- | --- | --- |
| `ACCESS_DENIED` / HTTP 403 | The airline or its edge rejected a request. It is not an empty flight list. | Stop the batch. Do not rotate proxies or automatically retry the denied request. Try again later only when access is available. |
| `CAPTCHA` / human verification | The site requires a challenge before returning fares. | Stop and use the airline normally. The collector does not claim a fare until a real fare response and matching page evidence are captured. |
| `RATE_LIMITED` / HTTP 429 | The site asked the client to slow down. | Let the batch stop; reduce local concurrency and wait before a later run. |
| `SESSION_EXPIRED` / HTTP 401 | The booking session is no longer valid. | Start a new session/run. Do not treat it as sold out. |
| `SITE_NETWORK_FAILURE`, timeout, `ERR_HTTP2_PROTOCOL_ERROR` | The request ended before a usable airline response arrived. The cause may be transport, the site edge, or the current connection. | Open that search's local event log and response metadata. If no HTTP fare response exists, no fare was collected. |
| `FORM_MISMATCH` | The route or date shown in the booking form did not match the requested search. | Do not accept any fare. Re-enter the exact route/date and retry only after confirming the form. |
| `CALENDAR_NAVIGATION_FAILED` | The calendar did not reach or select the requested date. | Confirm the travel date shown on the page. The collectors include calendar-navigation handling, but a failed date check remains a failure. |
| `EMPTY_RESULTS` | A valid search returned no matching itinerary rows. | This is an empty result for that exact route/date, not proof that all seats are sold out. |
| `FARE_RESPONSE_UNVERIFIED` | The page and airline response could not be reconciled safely. | Keep the outcome as unverified; inspect the saved evidence locally. |

## Known dated issues

- **IndiGo, 9 October 2026:** earlier runs received HTTP 403 after a flight-search
  request; the browser surfaced a generic network/CORS error because the
  rejection omitted a CORS header. A later, bounded persistent-Chrome batch
  succeeded for four searches and saved 259 verified fares. That confirms that
  tested batch only; it does not identify the airline's rejection rule or
  guarantee future access. See
  [IndiGo diagnosis](indigo-collector/docs/reliability-2026-10-09.md) and
  [headless run evidence](indigo-collector/docs/headless-worker-2026-10-09.md).
- **Akasa, 27 September 2026:** two T+1 checks failed because the displayed
  month abbreviation `Sep` was compared with `Sept`. The date matcher was
  corrected; individual retries then collected fares. Other network, access,
  calendar, and session failures remain explicit failures. See
  [Akasa stress-test notes](akasa-collector/STRESS-TEST-2026-09-27.md).
- **Air India:** recorded failures include HTTP 403 at the booking handoff,
  CAPTCHA/audio challenges after HTTP 200, and a headless authentication-token
  request timing out before any fare request. These are different failure
  stages; changing browser mode alone did not guarantee a fare response. See
  [Air India status notes](airindia-collector/STATUS.md).
- **Air India Express:** a recorded headless attempt timed out during its
  anonymous-session token request before the fare request. Headed Chrome is
  the documented default. No fare is inferred when that token step fails. See
  [Air India Express guide](airindia-express-collector/README.md).

Historical fare amounts and run timestamps are observations from those dates,
not current quotes or reliability guarantees.

## Credentials, logs, and installation

Normal fare collection needs no airline account, API key, paid data service, or
GitHub login for this public repository. Node.js, Google Chrome, and internet
access are required; the collector-specific guides list any additional
platform package. Python/FFmpeg are only needed for the optional Air India
helper described in its guide.

Proxy use is optional. If an authorized proxy requires credentials, keep them
in local environment variables and never paste them into a public issue or
commit them. Do not upload `.session/`, `.env`, `runs/`, `web-runs/`, HAR files,
raw logs, or screenshots. Share a short redacted error code and timestamp
instead. Setup guides:

- [IndiGo](indigo-collector/README.md)
- [Akasa Air](akasa-collector/README.md)
- [Air India](airindia-collector/README.md)
- [Air India Express](airindia-express-collector/README.md)
