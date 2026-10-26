# Reliability framework

The collector can only report a fare when IndiGo's live flight-search response and
the visible fare-details panel agree. No browser, proxy, or retry scheme can
guarantee that the airline will grant access. The framework makes failures
attributable and prevents a failed search from becoming an invented fare or a
"sold out" claim.

## Search state machine

Every attempt records these ordered stages in `result.json` and `events.ndjson`:

`browser_ready → homepage_loaded → widget_ready → route_date_confirmed →
search_submitted → results_rendered → airline_response_verified → fare_verified → complete`

The last completed stage and exact failure cause identify where a run stopped.
`widget_ready` includes a connection qualification record: homepage status,
visible booking controls, booking-widget resource outcomes, and the verified
proxy exit where configured. It does not claim that a later flight POST will
succeed. Route and date are checked before submission.

For Chromium, `network-diagnostics-attempt-N.json` records the IndiGo booking
requests' start, path, method, HTTP status, protocol, remote IP, TLS protocol and
issuer when available, plus Chrome's network or CORS failure reason. It never
reads or saves request headers, cookies, POST bodies, or authentication tokens.
`network.json` continues to record the browser-independent request outcomes.
The normal Chrome launcher also accepts opt-in `--netlog` for deeper transport
diagnosis. Its private, bounded file remains outside the run evidence package;
the collector does not mine it for fares or treat a protocol error as a proven
access block. A local launch-and-close smoke test produced valid NetLog JSON.

On 26 September, a manual Firefox search on the current Wi-Fi showed fares while
a reused collector profile received a flight-search 401 with
`core:Token:Invalid`. A clean profile using direct Chrome requests then completed
two searches, and a fresh installed copy repeated both successfully. The paired
result supports session validity as one concrete cause of failure. Earlier
HTTP/2 resets remain a separate observed failure; a protocol error alone does
not establish bot detection or a browser defect.

## Connection and session control

- `npm run collect:chrome` launches a normal installed Chrome with a dedicated
  persistent profile and a local-only debugging port. Other modes use their own
  persistent profiles. One proxy exit has one browser profile.
- `--proxy` and `--proxy-pool` verify public exit IPs before IndiGo requests.
  A CDP-attached proxy is compared with a separate browser probe using the
  requested proxy. Different exits never share session cookies.
- Searches are sequential with a configurable minimum interval. Transient
  failures receive bounded backoff. A repeated matching network failure on the
  only available exit opens a circuit after two observations and stops the
  batch. Remaining route/date requests are recorded as `skipped`.
- HTTP 401/403 access denial and visible CAPTCHA stop immediately. A flight
  401 with `core:Token:Invalid` is `SESSION_INVALID`. In a collector-owned
  Chromium session, the collector clears IndiGo-only site data once and retries
  if a retry is available; it stops on a repeat session failure. It never
  clears a separately attached Chrome session. HTTP 429 remains a rate-limit
  cause. Session expiry and genuine empty results have
  separate causes; neither is reported as a sold-out flight.
- `--auto-transport` starts with the browser connection. If the booking-widget
  resources fail at the transport layer, and the optional pinned Python bridge
  is installed, its next bounded attempt uses that bridge for site resources.
  It does not replay a denied request or use the bridge to manufacture a flight
  response. The strategy selected on each attempt is recorded.
- For a diagnosed HTTP/2 failure on the airline flight POST,
  `INDIGO_CHROME_HTTP1=1` launches normal Chrome with HTTP/2 disabled and
  records that diagnostic mode in the manifest. This is a controlled transport
  experiment, not a default success claim.

## Evidence and offline QA

Each attempted search has a timestamped `result.json`. Page captures use
attempt-specific filenames so a retry cannot overwrite an earlier screenshot
or HTML snapshot. If a page closes before capture, the collector records a
hashed capture error and leaves the HTML and screenshot paths empty. A verified
fare requires real result-page HTML and a screenshot. Successful fares also
have the airline response, result-page HTML/screenshot, selected row HTML, fare
details HTML/screenshot, route, date, flight, base, tax, total, and SHA-256
hashes. JSON checkpoints are written atomically as stages advance and after
each fare, so an interrupted run retains its last recorded state. Evidence
files are private to the current user by default.

Run the read-only verifier against one or more completed run directories:

```bash
npm run verify:runs -- /absolute/path/to/run-1 /absolute/path/to/run-2
```

It re-reads every quoted fare from its saved IndiGo response, checks the route,
date, flight, arithmetic, matching page files, and hashes. For failed searches,
it checks the event, network, page-error, and page-capture records, including
their hashes. Older runs without per-file hashes can still be checked,
but receive a legacy warning. A failed run can have valid failure evidence;
`validEvidence` does not mean it collected a fare.

The release gate is intentionally harder than one successful run: at least
20 attempted searches, two routes, two dates, three separate run days, a 95%
completed-search rate, one collector source fingerprint, and no
evidence-verification errors. The verifier only
reads existing runs; it does not send extra airline traffic to meet this gate.
Runs marked with `diagnosticInjection` are verified as evidence but excluded
from all release-gate counts, including searches, days, and success rate.
For a meaningful gate, pass every consecutive production run from the same
package version and connection during a declared evaluation window, including
failures. The verifier cannot prove that a caller did not omit a run directory;
an operator must retain the complete cohort.
`sourceFingerprint` is computed from the package manifest, lockfile, collector,
browser launcher, and verifier source at run start. If implementation code
changes during an evaluation, begin a new cohort for the new fingerprint.
Meeting it describes measured performance on the tested connection and dates,
not permanent access to IndiGo.

## Latest clean-install result

The 26 September clean copy in `work/fresh-package-v25/indigo-scraper/`
installed with `npm ci`, passed 37 JavaScript tests, and completed two live
searches from a new Chrome profile. DEL–BOM on 27 September and DEL–BLR on
5 October each produced two fares with an IndiGo HTTP 200 flight response and
page/fare-details evidence. The run is
`outputs/goal-fresh-v25-live-runs/2026-09-26T05-04-13-701Z-7656b7/`;
its verifier found no evidence errors. This does not satisfy the three-day,
20-search release gate.
The subsequent one-time, IndiGo-only session reset passed unit tests and real
Chrome site-data clearing checks. A controlled diagnostic then injected an
invalid-token 401 on the first flight POST. The collector reset its owned
IndiGo session, retried, and captured one real fare from the airline's second
flight response. This exercises the full recovery path, but the initial 401
was injected rather than a natural site response. The diagnostic run is
excluded from the release gate. The prior archive extracted, installed, and
passed 39 JavaScript tests.

Later on 26 September, a clean direct-Chrome package on the currently connected
CMF Wi-Fi captured DEL–BOM at ₹6,147. A second route reached an HTTP 200 flight
response but failed at the fare-details panel after a Lite-fare popup appeared;
the run correctly emitted no quote. A diagnostic run showed that the details
panel can open normally on the same route. A bounded second click with popup
dismissal then captured a verified DEL–BLR fare at ₹8,671. The current source
also limits repeated row errors and stops on a closed page. Since the source
changed, the prospective reliability cohort must start with the current
fingerprint; older successful and failed runs remain separate evidence.

### Earlier failed installations

The packaged source was extracted into a fresh directory, installed with
`npm ci` and a new Python virtual environment, and passed 27 JavaScript and
4 Python tests before the 25 September live run. The controlled
`INDIGO_CHROME_HTTP1=1 --auto-transport` test submitted DEL–BOM for 3 October
and DEL–BLR for 5 October. Its browser connection stalled loading the widget;
the bridge loaded it, and both searches reached `search_submitted`. On each
route, the flight-search POST remained pending through the 45-second results
window. The server returned no flight body, so this run captured zero fares:
`outputs/fresh-v14-http1-live-runs/2026-09-25T05-11-33-712Z-947693/`.
The stronger verifier found three mismatched page hashes in its second route:
the earlier implementation reused filenames across retries and overwrote
earlier evidence. That historical run is now correctly marked invalid; its
missing original bytes cannot be reconstructed. The run's original label was
`RESULTS_UNVERIFIED`; after inspecting the pending POST, the source now labels
this case `SITE_NETWORK_FAILURE` and opens the single-exit circuit after two
matching stalls. Both corrections are tested, but a new live fare after them
has not been observed. A separate clean-install trial kept document navigation
in Chrome while bridging other resources. It failed at the homepage on retry
with `ERR_HTTP2_PROTOCOL_ERROR`, so the default remains the broader bridge.

The subsequent v19 source archive was extracted into another clean directory,
installed with `npm ci` and the pinned bridge requirement, and passed 35
JavaScript and 4 Python tests. A fresh DEL–BOM 2026-10-03 attempt rendered the
form using the automatic bridge fallback and submitted the search at
2026-09-25T05:46:15Z. Chrome then reported `net::ERR_HTTP2_PROTOCOL_ERROR` on
the airline's flight-search POST. The result is `SITE_NETWORK_FAILURE`, with
zero new fares and `search_submitted` as its final completed stage. The
failure's page, network, event, and result evidence passed the run verifier.
The unresponsive-worker and closed-page paths are now bounded and have targeted
tests. The run is
`outputs/resume-v19-live-runs/2026-09-25T05-45-21-104Z-1fd6aa/`.

A separate Tor SOCKS exit returned HTTP 403 for a public booking-widget
resource, so collection stopped before any route/date search through it.
WARP and the machine's default route were not changed. This is an access
denial on that specific exit, not a statement about flight availability.
Neither the clean package run nor the Tor preflight meets the repeat-success
release gate.

On 26 September, opt-in Chrome NetLog showed that two submitted flight POSTs
received HTTP/2 stream resets with `INTERNAL_ERROR`; the same connections also
reset unrelated IndiGo resources, and one received `GOAWAY(PROTOCOL_ERROR)`.
The flight requests reached two Akamai edge IPs. The run's two route/date
results both failed with valid evidence and zero fares. A single opt-in
HTTP/1.1 bridge POST using the browser's session headers then timed out with
zero bytes received. It was not retried. The bridge experiment has a dedicated
flag and remains outside the default collection path. These observations do
not prove bot detection or a machine-only defect; a contemporaneous manual
Chrome comparison or trusted second connection is needed to distinguish them.

## Ubuntu commands for the normal Chrome path

Install Node.js 20 or newer, installed Google Chrome, and the package as shown
in `README.md`. To enable the bounded public-resource fallback:

```bash
sudo apt-get install -y python3 python3-venv
python3 -m venv .bridge-venv
.bridge-venv/bin/python -m pip install -r requirements-bridge.txt
export INDIGO_PYTHON="$PWD/.bridge-venv/bin/python"
npm run collect:chrome -- \
  --auto-transport \
  --search DEL:BOM:2026-10-03 \
  --search DEL:BLR:2026-10-05
```

Replace the sample dates with future travel dates. If no verified proxy is
available, the collector reports the failed direct connection; it does not
claim that changing user-agent text or adding retries solved it.
