# Direct IndiGo fare collector

This is a browser-driven collector for the public booking flow at `www.goindigo.in`. It uses no paid fare API, account, or credentials. It detects CAPTCHAs and can optionally pause for a person to solve one; it never claims an automated solve or rotates proxies after an access block. Browser access and page structure vary by network and date; successful installation does not guarantee that IndiGo will return search results.

The staged recovery, private network diagnostics, evidence verifier, circuit
breaker, and measured release gate are specified in [`RELIABILITY.md`](RELIABILITY.md).

## Ubuntu setup

On an Ubuntu desktop with Node.js 20 or newer, install Chrome and the package:

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl wget python3 python3-venv xvfb xauth
curl -fsSL https://deb.nodesource.com/setup_22.x -o nodesource_setup.sh
sudo -E bash nodesource_setup.sh
sudo apt-get install -y nodejs
node --version                    # must be v20 or newer
wget -q https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
sudo apt-get install -y ./google-chrome-stable_current_amd64.deb
cd /path/to/indigo-scraper
npm ci
INDIGO_DATE_A=$(TZ=Asia/Kolkata date -d '+5 days' +%F)
INDIGO_DATE_B=$(TZ=Asia/Kolkata date -d '+9 days' +%F)
npm run collect:chrome -- --search "DEL:BOM:$INDIGO_DATE_A" --search "DEL:BLR:$INDIGO_DATE_B" --interaction-delay-ms 1800 --all-flights
```

## Local route and date page

After setup, start the local page with:

```bash
npm run web
```

Open `http://127.0.0.1:8787` on the same computer. Enter routes such as `DEL-BOM` and `LKO-PAT`, choose any of T+1, T+5, T+9, T+15, T+30, and T+45, choose **Visible Chrome** or **Headless Chrome**, then click **Collect all flights**. The page creates every route/date search and picks a bounded worker count automatically: one for a single search, up to two for a batch. New searches start at least 20 seconds apart; a batch is limited to 36 searches. Each worker keeps a persistent profile for its browser mode. Headless Chrome launches with `--headless=new`, a version-matched normal Chrome user-agent string, and a `headless-cdp` manifest label. The page streams real browser/search/evidence stages, records failures without fares, and stops its queue if IndiGo denies access or presents a CAPTCHA.

A separate Firefox headless check on 27 September loaded the homepage but its booking-widget requests reset. One run with the optional TLS bridge rendered the widget and submitted LKO–PAT, then the airline's `/v2/flight/search` request failed with `NS_ERROR_NET_RESET` before a fare response. Neither run yielded a verified fare. The bridge does not replay or cache flight prices.

By default each search verifies **every** exact-route journey returned in IndiGo's flight response against its displayed row, flight numbers, and starting price. It saves the lowest displayed starting fare for each flight with the base/tax breakdown from that matching response. The page shows a flight count and a compact list sorted by starting fare. If any airline journey cannot be matched to the page, the result is **incomplete**, with the cause and partial evidence retained. A `--max-flights N` CLI option remains for bounded fare-panel diagnostics; it deliberately does not claim full-flight coverage. The ten route shortcuts are search directions for city pairs listed in the [Category I table of DGCA's Route Dispersal Guidelines](https://www.dgca.gov.in/digigov-portal/Upload?attachId=iF%2FlBZytqR3ArkATtr1K2A%3D%3D&flag=iframeAttachView). Category I is a regulatory grouping, **not** a current traffic-volume ranking or guarantee of IndiGo service on a chosen date.

The headed Chrome check captured **17 of 17** LKO–PAT flights for 2 October 2026, with matching page and airline-response evidence. The lowest displayed starting fare was ₹4,901 for flight 6E 6902 at 16:45; its response showed ₹3,000 base fare and ₹1,901 taxes and fees. The headless CLI check captured **68 of 68** exact-route DEL–BOM journeys for 6 October 2026; nine nearby-airport rows were excluded. Its lowest displayed starting fare was ₹6,090 for connecting journey 6E 6261 + 6E 6285, with ₹4,521 base fare and ₹1,569 taxes and fees. A headless **page-run** check also captured **17 of 17** LKO–PAT flights for 2 October 2026 in `web-runs/2026-09-27T04-15-54-150Z-c863c2/`; the first attempt timed out and the retry succeeded. These successful runs passed the read-only evidence verifier; they do not prove that every future search will work or satisfy the measured release gate.

The page binds only to localhost. Its batch records and the collector's individual manifests, logs, screenshots, result files, and airline responses are saved under `web-runs/`; browser profiles are under `.session/web-agents/`. Prices shown in the page come only from saved runs that pass `verifyRun`. The page never turns a failed or empty response into a sold-out fare. The Stop button interrupts current agents and leaves the evidence already saved on disk. A proxy without authentication can be set before launching the page using `INDIGO_PROXY_SERVER`; the underlying CLI also supports a validated proxy pool, but the Chrome page does not rotate proxies after an access denial.

Choose future dates when running the command. The Node.js 22 repository steps follow [NodeSource's Ubuntu instructions](https://github.com/nodesource/distributions/blob/master/DEV_README.md). The `collect:chrome` command launches installed Chrome with a dedicated persistent profile, attaches the collector through a local debugging port, and closes only the Chrome process it started. It does not require a Playwright browser download. Its Chrome profile is `.session/normal-chrome`; set `INDIGO_CHROME_PROFILE` and `INDIGO_CHROME_PATH` to override the profile or executable. Use `npm run collect` for the separate Firefox/Playwright launch modes and proxy pools. A graphical desktop is needed for visible Chrome; `--headless` runs without one.

The direct Chrome path above produced verified live fares from a fresh installation
on 26 September 2026. The optional Python bridge is only needed for
`--tls-bridge` or `--auto-transport`: create `.bridge-venv` and install
`requirements-bridge.txt` before selecting either option. It did not improve
the successful run here. To check saved fares and see the measured release gate, run
`npm run verify:runs -- /absolute/path/to/run-directory`.

The Chrome launcher chooses a free, nonzero debugging port bound to localhost.
On this machine, headed Chrome started with port `0` reported
`navigator.webdriver = true`; the same Chrome started with a nonzero port
reported `false` after the collector attached. This matches the documented
[Chrome `navigator.webdriver` behavior](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/webdriver).
Each attempt logs `browser_automation_signal`. This removes one observable
automation flag but does not establish that IndiGo will allow the flight search.

For a controlled Chrome network diagnosis, add `--netlog` to `collect:chrome`.
It writes a size-limited Chrome NetLog to the dedicated profile, prints its
absolute path, and gracefully closes Chrome so the JSON is complete. The file
is private to the current user and is not copied into the run folder or source
archive. Chrome's default capture strips private information, but NetLog may
still contain sensitive URLs or session details: review it locally before
sharing. Use this for one paired manual-versus-collector or alternate-network
comparison, not as a reason to repeat the same failed route on the same exit.

```bash
npm run collect:chrome -- --netlog --auto-transport --search DEL:BOM:2026-10-03
```

The optional bridge uses a browser-like TLS client for IndiGo site files that reset in Firefox. If using the bridge separately, install it as above and run:

```bash
npm run collect -- --search DEL:BOM:2026-10-03 --tls-bridge --headless
# Or use the normal Chrome path with the same optional bridge:
npm run collect:chrome -- --search DEL:BOM:2026-10-03 --tls-bridge
```

Choose a future travel date. The bridge uses the same configured proxy as the browser. It carries request headers and the request body for the airport lookup, but omits cookies on public page resources because those requests repeatedly reset on this test connection when a browser cookie was sent. Homepage response cookies are added to the persistent browser session. It keeps one browser-compatible HTTP worker per browser session, limits pending resource requests, retries a transport error twice with short backoff, and lets the browser try the original request if the worker still fails. It records returned HTTP statuses and fallback causes. CAPTCHA and denial handling stays in the collector. Certificate verification is never disabled. It does not guarantee that IndiGo will accept the booking search. In CDP mode, the bridge is removed after each attempt so the attached browser session remains usable.

The worker renews its HTTP connection after at most 40 requests. It does not bridge decorative images. A bridge request has a 15-second deadline, and shutdown terminates an unresponsive worker. To check the optional bridge's request handling after installation, run `.bridge-venv/bin/python -m unittest discover -s test -p 'test_*.py'`.

Within one collection run, the bridge keeps successful public IndiGo JavaScript and CSS in memory and reuses those files across retries and route searches. It does not cache homepage HTML, booking settings, airport lookups, flight-search responses, fares, or session requests. Each run begins with an empty code cache, so a live fare always requires a fresh flight-search response.

If Chrome reports `ERR_HTTP2_PROTOCOL_ERROR`, `--browser chromium --chrome-path /usr/bin/google-chrome --chrome-http1` is a diagnostic option that disables HTTP/2 in the locally launched browser. It did **not** make the booking widget work on the test machine, so it is not a recommended default.

## Collect

```bash
npm run collect:chrome -- \
  --search DEL:BOM:2026-10-03 \
  --search DEL:BLR:2026-10-05
```

Use future travel dates when you run it. Searches run one at a time. The default minimum gap is ten seconds; transient failures get at most two retries with increasing delay and jitter. An explicit access denial ends the batch immediately. A CAPTCHA also stops the batch by default. On a headed desktop with an interactive terminal, `--captcha-handoff` pauses once for you to solve a visible challenge, then rechecks the page and retries with the same browser profile. An empty result is recorded as `EMPTY_RESULTS`, never called sold out. Rows that cannot be matched to the requested airports and a complete fare breakdown are not emitted as quotes.

To test whether fast form interactions affect a search, add `--interaction-delay-ms 1200`. This adds logged pauses between field actions and types airport codes as key presses. It also rechecks for a visible challenge or access denial before submitting. The value is recorded in the run manifest. This is a controlled pacing option, not proof that the browser appears human or that IndiGo will return fares.

Access checks cover the booking widget, session refresh, result page, and IndiGo flight-search host. HTTP 401/403 from a booking resource stops on `ACCESS_DENIED`, except that HTTP 401/403 from session refresh is recorded as `SESSION_EXPIRED` and a flight-search 401 with IndiGo's `core:Token:Invalid` body is recorded as `SESSION_INVALID`. For these specific session faults, an owned Chromium profile clears only IndiGo site data once and retries if the run has a retry available; another failure stops the batch. An attached Chrome session that the launcher does not own is never cleared. Generic access denial and CAPTCHA stop immediately. HTTP 429 is recorded as `RATE_LIMITED` and receives bounded backoff without switching proxy identity. Failures in unrelated page features, such as the chat widget, remain in `network.json` but do not falsely mark a fare search blocked.

Persistent browser state is stored in `.session/`; each invocation creates a new timestamped folder under `runs/`. Do not run two processes against the same profile at once. If you want to use your own Chrome session, launch Chrome with a dedicated profile and a local debugging port, then pass `--browser chromium --cdp-url http://127.0.0.1:9222` to `npm run collect`. Keep that port bound to localhost.

### Proxy

Set a proxy before launching the browser. The collector does not change it during a session or use a new proxy to retry a block.

```bash
export INDIGO_PROXY_SERVER='http://proxy.example:8080'
export INDIGO_PROXY_USERNAME='username'       # only when required
export INDIGO_PROXY_PASSWORD='password'       # only when required
npm run collect -- --search DEL:BOM:2026-09-30
```

An unauthenticated proxy can also be passed with `--proxy`. With the normal-Chrome launcher, use `npm run collect:chrome -- --proxy http://host:port --search ...`; it configures Chrome before startup and compares the attached browser's observed public exit IP with a separate probe through that proxy before an IndiGo request. This combined proxy path has not produced a live fare in the checks here. A CDP-attached browser must already have its proxy configured. Authenticated proxies and proxy pools use `npm run collect`, which launches browsers with those settings directly. Never put credentials in the proxy URL. Review page evidence before sharing it because live HTML can contain session state.

For multiple proxies, copy [`proxy-pool.example.json`](proxy-pool.example.json) and replace the example servers with working proxy endpoints. Then run `npm run collect -- --proxy-pool /path/to/proxy-pool.json --search DEL:BOM:2026-10-03`. The collector checks each proxy through a real browser at [ipify](https://www.ipify.org/), falling back to [Cloudflare's trace endpoint](https://developers.cloudflare.com/fundamentals/reference/cdn-cgi-endpoint/). It starts collection only after verifying at least two distinct public exit IPs. Duplicate, unreachable, and direct entries cannot count as rotating exits. Immediately before an IndiGo attempt it checks the selected proxy's exit again; an unverified or changed exit cools that proxy and selects another on the next bounded retry.

Each accepted proxy has its own persistent browser profile, so its cookies stay tied to that exit. The collector rotates after transport, proxy-exit, or proxy-specific TLS failures, cools down the failing proxy, and records the proxy ID and verified exit IP in the run log. It **stops on an IndiGo CAPTCHA or access denial**. Optional authenticated entries use `usernameEnv` and `passwordEnv` names pointing to environment variables; the run files never store the credentials. A proxy pool supplies connectivity; the program does not manufacture working IP addresses. A public proxy list may contain endpoints that pass an IP check yet fail to load IndiGo, so passing preflight is not a fare-search success.

A single `--proxy` is also checked through the launched browser before an IndiGo request. Its observed exit IP and verification time are recorded; if the check fails, the collector does not silently use direct access. Single-proxy mode cannot rotate to a second exit.

## Output and interpretation

Each run saves:

- `manifest.json`: requested route/date pairs, collection times, status, results,
  and a SHA-256 fingerprint of the collector source used for that run.
- `events.ndjson`: timestamped search, fare, retry, and failure events.
- One folder per attempted search with `result.json`, `network.json`, `page-errors.json`, and attempted page captures. A closed page produces a hashed capture-error file instead of fabricated empty HTML or a screenshot.
- For each verified flight in the default all-flights mode, a row HTML fragment. Each search also saves its results-page HTML and screenshot.
- When a search reaches results, `flight-search-attempt-N.json`: the live IndiGo flight-search response, saved with private file permissions. The collector matches every exact-route journey key, flight number, and displayed starting fare against this response. Base airfare, tax, and total come from the matching lowest INR offer. If any response journey cannot be verified against a displayed row, the search is marked incomplete. The optional `--max-flights N` diagnostic mode additionally saves fare-details HTML and screenshots for its selected flights; that mode does not claim full-flight coverage.
- If the flight-search endpoint returns HTTP 401, 403, or 429, a bounded copy of that response body is saved as `flight-search-http-...bin` with private file permissions and linked from `result.json`. Request cookies and bodies are never saved in that file. The collector still stops on access denial.

Each quote contains the flight number(s), route, travel date, collection timestamp, departure and arrival times, fare brand, base airfare, taxes and fees, displayed total, and paths to its evidence. The displayed total is the amount shown at flight selection. IndiGo says a convenience fee may apply later in checkout; the collector does not invent that fee or treat this amount as a final payment total.

If a later row fails or the page becomes blocked after a quote was verified, `result.json` retains the earlier quote and its evidence while recording the later failure. A blocked batch stops immediately, including when it has already captured a fare.

Exit code `0` means all attempted searches had verified fares. Exit code `2` means a failed, blocked, or partial run. The code never reads old run folders as prices.

## Why this stack

The collector uses a real JavaScript browser, a separate persistent profile for each proxy, one-at-a-time searches, transport-error cooldowns, and source-page evidence. This is the same division of responsibilities described by [Crawlee's session pool](https://crawlee.dev/js/docs/next/guides/session-management) and [Scrapy's AutoThrottle](https://docs.scrapy.org/en/latest/topics/autothrottle.html), tuned here for one airline and strict failure reporting. [Web Scraper's extension](https://webscraper.io/documentation/) is useful for building selectors interactively, but the fare-details checks and evidence policy here need code. [Browserless](https://docs.browserless.io/overview/getting-started/bypass-captchas) and [Zyte](https://docs.zyte.com/zyte-api/usage/browser.html) offer managed browsers, proxies, and CAPTCHA handling, but their API tokens conflict with the no-credential requirement. No browser or proxy pool guarantees access when the site's booking resources fail on the available network.

## Latest verified live check on this machine (26 September 2026 IST)

A clean copy in `work/fresh-package-v25/indigo-scraper/` installed with `npm ci`,
passed 37 JavaScript tests, and then collected two fresh searches in one headed
Chrome run on the `current Wi-Fi connection` Wi-Fi. The run is
`outputs/goal-fresh-v25-live-runs/2026-09-26T05-04-13-701Z-7656b7/`
(timestamps in UTC). The read-only verifier reported `status: ok`, two completed
searches, four fares, `validEvidence: true`, and no errors or warnings.

| Travel date | Route | Flight | Base | Taxes and fees | Displayed total |
| --- | --- | --- | ---: | ---: | ---: |
| 2026-09-27 | DEL–BOM | 6E 6218 | ₹4,700 | ₹1,447 | ₹6,147 |
| 2026-09-27 | DEL–BOM | 6E 320 | ₹4,700 | ₹1,447 | ₹6,147 |
| 2026-10-05 | DEL–BLR | 6E 846 | ₹6,848 | ₹1,823 | ₹8,671 |
| 2026-10-05 | DEL–BLR | 6E 871 | ₹6,848 | ₹1,823 | ₹8,671 |

Each quote has a collection timestamp, IndiGo flight-search HTTP 200 response,
matching result-page HTML and screenshot, and the opened fare-details panel.
These are flight-selection totals; IndiGo says a convenience fee may apply.
The repeat-success release gate in `RELIABILITY.md` is still open because this
test covers one day and two searches, not 20 searches over three days.

A later controlled run from a copy of the older profile completed DEL–BOM again
without receiving an invalid-token response. The one-time session-reset code
has passed isolated tests in real Chrome, including proof that unrelated
cookies remain. A separate diagnostic run injected a `core:Token:Invalid` 401
into the first flight request; the collector recorded `SESSION_INVALID`, cleared
IndiGo site state once, retried, and then captured a **real** IndiGo fare from
the second flight request (`outputs/goal-session-fault-injection-runs/2026-09-26T05-18-06-341Z-eefb99/`). The first response was deliberately
injected, so this proves the recovery path works under fault injection; it
does not prove that a naturally invalid session will always recover. The
verifier labels and excludes this diagnostic run from the long-run release
gate. Diagnostic injection code is outside the delivered source archive.
The updated source archive was separately extracted into
`work/final-archive-check-v26/indigo-scraper/`; `npm ci` and all 39 JavaScript
tests passed before the verifier update. No live fares or failure responses
are bundled in that archive.
New production runs now record a source fingerprint. The long-run reliability
gate requires all counted runs to share that fingerprint; earlier runs remain
valid fare evidence but cannot alone satisfy this newer stability measure.

On the CMF connection on 26 September, the freshly extracted package captured
DEL–BOM flight 6E 353 for 3 October at ₹6,147 with valid evidence
(`outputs/reliability-cohort-cmf-v28/2026-09-26T09-15-14-757Z-a99510/`). Its
next DEL–BLR run received the airline response but failed to open the fare
details panel; the failure was recorded as `PARSER_UNVERIFIED`, with zero fares
(`outputs/reliability-cohort-cmf-v28/2026-09-26T09-16-35-969Z-459c42/`).
A focused diagnostic showed that a Lite-fare popup can cover later fare clicks.
After adding bounded dialog reopening and popup dismissal, a new source build
captured DEL–BLR flight 6E 846 for 5 October at ₹8,671 with valid evidence
(`outputs/reliability-cohort-cmf-v29/2026-09-26T09-24-18-913Z-f612db/`).
The final source additionally stops after five consecutive row errors or a
closed page, rather than scanning every flight after a systemic UI failure.
These runs use different source fingerprints and must not be combined into one
same-build reliability cohort.

## Earlier verified live check (25 September 2026 IST)

A dedicated normal Chrome session and the packaged collector completed both submitted searches on 25 September 2026 IST (`outputs/manual-cdp-live-runs/2026-09-24T19-24-37-775Z-8cbe8f/`, timestamps in UTC). `manifest.json` reports `ok`; each result has a matching IndiGo flight-search HTTP 200 body, page HTML, screenshot, selected fare-detail HTML/screenshot, route/date, and collection time. The recorded fares were:

| Travel date | Route | Flight | Base | Taxes and fees | Displayed total |
| --- | --- | --- | ---: | ---: | ---: |
| 2026-10-03 | DEL–BOM | 6E 353 | ₹4,700 | ₹1,447 | ₹6,147 |
| 2026-10-03 | DEL–BOM | 6E 449 | ₹4,700 | ₹1,447 | ₹6,147 |
| 2026-10-05 | DEL–BLR | 6E 850 | ₹6,848 | ₹1,823 | ₹8,671 |
| 2026-10-05 | DEL–BLR | 6E 828 | ₹6,848 | ₹1,823 | ₹8,671 |

These are live observed fares, not fixtures or a guarantee of later prices. The convenience fee may apply later, as the site states.

The source archive was separately extracted into clean `work/fresh-package-v10/indigo-scraper/`, then installed with `npm ci`; all 24 JavaScript tests passed. Its new Chrome profile failed at the booking widget because `bw-main.json`, `bw-additional.json`, and `/v1/setting/indigowidgets` returned `net::ERR_HTTP2_PROTOCOL_ERROR` on both routes (`outputs/fresh-v10-chrome-live-runs/2026-09-24T19-30-59-523Z-67a015/`). Reusing the successful Chrome profile let that clean installation submit both searches, but `/v2/flight/search` then failed with `net::ERR_FAILED` on both routes (`outputs/fresh-v10-reused-profile-live-runs/2026-09-24T19-34-39-970Z-730e3a/`). Both clean-install runs saved failure evidence and **zero new fares**.

An earlier archive was extracted again into `work/fresh-package-v11/indigo-scraper/`, installed with `npm ci` and the optional pinned Python bridge dependency, and passed 24 JavaScript plus 4 Python tests. The normal-Chrome-plus-bridge run loaded the widget and submitted **both** route/date searches. Each airline flight-search POST failed with `net::ERR_HTTP2_PROTOCOL_ERROR` (`outputs/fresh-v11-chrome-bridge-live-runs/2026-09-24T19-39-42-115Z-6a391a/`). It captured **zero fares**. No later repeated request was sent through that same failing transport. This clean installation has not demonstrated reliable repeat success; the successful four-fare run above is the live proof for its earlier, equivalent collector core. A different network path or working proxy exit is needed to validate repeat collection on this machine. WARP was left unchanged.

The new reliability framework was then tested from another clean extraction with the optional bridge. On 25 September, both DEL–BOM and DEL–BLR searches were submitted, but each flight-search POST failed with `net::ERR_HTTP2_PROTOCOL_ERROR`; the circuit opened after the second matching failure (`outputs/fresh-v13-framework-live-runs/2026-09-25T05-05-57-536Z-fd47ea/`). A separate clean extraction with HTTP/2 disabled in Chrome submitted both searches through the bridge. The flight POSTs then stayed pending past the 45-second result window, with no airline fare response (`outputs/fresh-v14-http1-live-runs/2026-09-25T05-11-33-712Z-947693/`). Both runs captured **zero new fares**. The source now classifies a pending flight POST as a network failure and trips the same-exit circuit after two matching stalls; that fix has passed targeted tests but has not yet produced a new live fare. A stronger `npm run verify:runs` check found three page-hash mismatches in the second route of the HTTP/1.1 run: a retry overwrote earlier `filled-search` and `results` files. The collector now gives every attempt distinct page filenames, and the verifier checks failed-run page files and logs too. The historical HTTP/1.1 run remains invalid evidence; its overwritten bytes cannot be recovered. The earlier four-fare run still verifies, with a legacy warning because it predates the required per-file hashes. The repeat-success release gate in `RELIABILITY.md` is **not met**.

A further clean-install trial kept top-level documents in Chrome while bridging other IndiGo resources (`outputs/fresh-v16-native-documents-live-runs/2026-09-25T05-22-19-247Z-527dd5/`). The first attempt failed to load booking widget JSON; the retry failed homepage navigation with `ERR_HTTP2_PROTOCOL_ERROR`. It captured no fare and never submitted a search. This selective mode was removed from the default build; the broader bridge remains because it reached flight submission.

The latest source archive was extracted into `work/fresh-package-v19/indigo-scraper/` and installed with `npm ci` plus a new Python bridge environment. All 35 JavaScript and 4 Python tests passed. A fresh DEL–BOM search for 3 October 2026 began at `2026-09-25T05:45:21Z` (`outputs/resume-v19-live-runs/2026-09-25T05-45-21-104Z-1fd6aa/`). The first attempt loaded the homepage but not the widget. Automatic transport fallback rendered the widget on attempt 2, confirmed route and date, and submitted the search at `05:46:15Z`. Chrome's `POST /v2/flight/search` then failed with `net::ERR_HTTP2_PROTOCOL_ERROR`; no IndiGo fare response arrived. The saved results screenshot shows IndiGo's "No Data Available" modal, but the failed POST makes this a transport failure rather than a sold-out result. The run exited with `SITE_NETWORK_FAILURE`, **zero new fares**, and a valid, hash-checked failure record. The bridge worker exited with the collector. This validates the new shutdown, cause-precedence, and page-capture handling in a live failure; it does not establish repeatable live collection.

An isolated local Tor SOCKS exit was also checked without changing WARP or the default route. Its public IP differed from the direct connection, but a public IndiGo booking-widget GET returned HTTP 403 (`outputs/network-preflight/2026-09-25T05-50-38Z-tor-exit.json`). No booking search was sent through that denied exit; the Tor process was stopped. A trusted alternate network or proxy path is still needed for another meaningful live collection test. Historical fares in the table above are timestamped observations, not current quotes.

On 26 September, a bounded two-route run with Chrome NetLog reached
`search_submitted` for DEL–BOM and DEL–BLR, then lost both airline flight-search
POSTs (`outputs/goal-v20-live-runs/2026-09-26T03-57-06-721Z-47ce3f/`). The
private NetLog shows HTTP/2 `RST_STREAM(INTERNAL_ERROR)` on each flight request
and on unrelated login, loyalty, and image requests sharing the sessions;
the second connection also received `GOAWAY(PROTOCOL_ERROR)`. The two Chrome
connections reached different Akamai edge IPs. Both runs saved valid failure
evidence and **zero fares**. This narrows the failure to the live transport
path but does not establish whether the edge, an intermediary, or an access
decision caused the resets.

An opt-in diagnostic `--tls-bridge --flight-http1-bridge` sends the flight POST
once over HTTP/1.1 with the browser's session headers, without caching or
retrying that POST. On this machine the DEL–BOM request received zero bytes
before a ten-second timeout (`outputs/goal-http1-flight-runs/2026-09-26T04-05-29-710Z-61ef15/`). This mode is **not a proven fare path** and is not
part of the default setup. It uses the existing denial detector for HTTP
responses and records transport failure instead of inventing a fare. Repeating the same connection is not the
next validation step; compare a manual Chrome search on the same connection
or test a distinct trusted exit. WARP remains unchanged.

The source archive was extracted into `work/fresh-package-v22/indigo-scraper/`.
`npm ci`, a new Python virtual environment with pinned `curl_cffi`, 36 JavaScript
tests, and 5 Python tests passed. The fresh installation was then tried on a
saved Wi-Fi connection with a public exit different from the original connection.
Without the bridge, both routes failed before the widget rendered
(`outputs/goal-altcmf-runs/2026-09-26T04-18-36-893Z-f366cd/`). With the
bridge, both routes reached `search_submitted`, but the flight POST reset on
each route (`outputs/goal-altcmf-bridge-runs/2026-09-26T04-21-43-898Z-71fc3c/`).
Both runs captured **zero fares**. The original Wi-Fi connection was restored.

An additional source-tree run used `--interaction-delay-ms 1800` on that
alternate exit. It paused between form actions and submitted DEL–BOM about 23
seconds after the booking widget became ready. The flight POST still reset
(`outputs/goal-paced-altcmf-runs/2026-09-26T04-35-05-306Z-78d883/`). The same
paced form with `--flight-http1-bridge` received no bytes before its ten-second
flight-request timeout (`outputs/goal-paced-h1-altcmf-runs/2026-09-26T04-41-27-592Z-d4b517/`).
These controlled tests do not show that fast form entry caused the failures;
they also do not rule out an access decision elsewhere in the site or edge.
Neither run produced a current fare, so the live-fare acceptance gate remains
unmet. The captured `flight-select.html` page shows IndiGo's "No Data
Available" modal after the request failure; no visible CAPTCHA or challenge
page was captured. The modal is not evidence of sold-out flights.

The launcher was then changed from Chrome debugging port `0` to a locally
chosen nonzero port. A controlled comparison confirmed that
`navigator.webdriver` changed from `true` to `false`. A paced DEL–BOM search
using the same alternate exit and persistent profile still lost the flight
POST with `ERR_HTTP2_PROTOCOL_ERROR`
(`outputs/goal-nonzero-cdp-altcmf-runs/2026-09-26T04-49-03-876Z-fb8d51/`).
This removes that one browser signal but does not resolve live collection or
identify the underlying reset cause.

## Earlier failed live checks (24 September 2026 IST)

A clean `npm ci` and browser installation succeeded on Ubuntu 26.04.1. The initial Chromium collector attempted DEL–BOM on 30 September, DEL–BLR on 3 October, and BOM–DEL on 5 October. All three reached the home page, but the booking widget did not render within 20 seconds. The trace records `net::ERR_HTTP2_PROTOCOL_ERROR` on IndiGo resources including `/content/api/s6web/in/en/v1/bw-main.json` and `/bw-additional.json`. No search was submitted in that Chromium run. The saved run is under `runs/2026-09-23T20-54-44-110Z-d8c493/` (timestamps in UTC). A separate bundled Firefox probe did render the widget. See the latest run folders for Firefox collection outcomes; do not treat the Chromium failures as evidence of zero flight availability.

The fresh-install Firefox collector then attempted DEL–BLR on 3 October in `runs/2026-09-23T21-15-37-767Z-a9d3b6/`. Its first attempt briefly rendered the widget before an IndiGo booking script failed with `NS_ERROR_NET_RESET` and the widget disappeared. Later bounded retries did not reach the search form. No fare was captured by that run. These are transport/rendering failures, not an empty flight result.

Further network diagnosis found that this machine receives certificates issued by `Sophos SSL CA_C910D12XYBXG68B` for `www.goindigo.in`, `app-prod-skyplus6e.goindigo.in`, and `api-prod-flight-skyplus6e.goindigo.in`. The local OpenSSL trust check for `www.goindigo.in` returned `self-signed certificate in certificate chain` (verify code 19). TLS inspection is present on this connection; that observation alone does not prove it caused every browser reset. The collector keeps certificate validation enabled and records explicit browser certificate errors as `TLS_TRUST_FAILURE` without retrying them. A network or proxy that supplies the actual site reliably is needed for a conclusive live collection test.

A controlled system Chrome probe forced HTTP/1.1 with `--disable-http2` while keeping certificate validation on. Navigation stopped at `https://www.goindigo.in/` with `net::ERR_CERT_AUTHORITY_INVALID`, before the booking widget or any search. Forcing HTTP/1.1 therefore did not solve access on this connection and is not enabled in the collector.

Later the same day, a new TLS check returned IndiGo's DigiCert certificate with a valid chain, without changing WARP. A fresh installation from the source ZIP then ran DEL–BOM (30 September), DEL–BLR (3 October), and BOM–DEL (5 October) once each in `runs/2026-09-24T01-49-35-579Z-36d69a/`. All three saved `result.json`, network logs, page errors, HTML, and screenshots. DEL–BOM received HTTP 200 for `bw-main.json` and `bw-additional.json` but lost the booking code chunk `80fa5e3ad769b360566551.js` with `NS_ERROR_NET_RESET` before destination suggestions appeared. The other two searches did not render the widget; network logs show resets on `/v1/setting/indigowidgets` and `/v1/token/refresh`. No search was submitted and **zero fares were captured**. Direct `curl` still returned an HTTP/2 `INTERNAL_ERROR` for `bw-main.json`. A further Chrome HTTP/1.1 probe got an HTTP 200 page and `remoteEntry.js`, but the widget's airport controls did not appear after 45 seconds. These observations do not establish an access denial or sold-out flights.

The later controlled Chrome run for DEL–BOM on 3 October (`work/research-runs/2026-09-24T11-54-55-336Z-e49f1c/`) failed before form entry: booking scripts and CSS returned `ERR_HTTP2_PROTOCOL_ERROR`. A Chrome HTTP/1.1 run (`work/research-runs/2026-09-24T12-03-11-258Z-9de7a9/`) also failed to render the form. A separate diagnostic relay fetched all five static booking assets directly from IndiGo with HTTP 200, but the page then reported failed site code chunks `5510` and `7408`. Direct `curl` to one of those `www.goindigo.in` chunks timed out over HTTP/1.1 and returned HTTP/2 `INTERNAL_ERROR`; both resolved IPv4 edges timed out over HTTP/1.1. The standalone collector still has **no completed live search or captured fare** on this machine.

For contrast, a separate Codex in-app browser completed a manual DEL–BOM search for 3 October. IndiGo's own `/v2/flight/search` response returned HTTP 200 at `2026-09-24T12:08:39.469Z`; flight `6E 353` had base airfare `₹4,700`, tax `₹1,447`, and total `₹6,147`. The displayed fare-details panel agreed. This manual observation informed the response cross-check implemented in this version; it is **not** a successful run of the downloadable collector and does not satisfy the live automation gate.

The packaged revision was installed fresh with `npm ci` and Playwright browser installation, and all 15 targeted tests passed. Its live Firefox search for DEL–BOM on 3 October failed before form entry in `outputs/indigo-scraper/runs/2026-09-24T12-15-53-333Z-60799d/`: `bw-main.json`, `bw-additional.json`, and `/v1/setting/indigowidgets` reset with `NS_ERROR_NET_RESET`. One direct, unauthenticated POST to the observed IndiGo `/v2/flight/search` endpoint returned HTTP 200 with an HTML `Oops! Something went wrong` page instead of fare JSON. That response is a site error, **not** a captured fare or evidence of sold-out flights. No working fallback was established.

Additional comparison on 24 September: the working in-app browser loaded site code chunks `5510` and `7408` over HTTP/2 from CDN edge `180.149.59.219`. Direct requests from the standalone environment to that same edge timed out over HTTP/1.1, and local HTTP/2 requests returned `INTERNAL_ERROR`. The working browser and local persistent Chrome profile both contained Akamai cookie names such as `_abck` and `bm_sz`. These observations rule out a simple missing-cookie-name or wrong-CDN-edge explanation; they do not prove whether the remaining difference is source network path, TLS/browser fingerprint, or another site decision. WARP was found manually disconnected and was left unchanged. No configured local proxy exit was available for a controlled alternate-egress run.

A bounded credential-free Tor SOCKS experiment used a workspace-local binary and port `127.0.0.1:19050`; it did not change system networking. Tor reached 50% bootstrap but did not establish an exit circuit within 120 seconds, so no IndiGo request was sent through it. This is not evidence that a working proxy would fail, and it is not a successful alternate-egress test.

The experimental `--tls-bridge` was tested later on 24 September. An isolated browser run loaded 32 site resources through the bridge and rendered the booking widget. The first full collector run loaded widget JSON but a separate `/booking/80fa5e3ad769b360566551.js` request reset, so destination suggestions never appeared. After adding booking JS/CSS to the bridge, a later run returned HTTP 200 for many resources, including widget JSON, but individual resources still sometimes failed with `curl: (92) HTTP/2 stream 1 reset by server`. A final bounded run recorded multiple such resets and failed at the widget stage. These runs are in `outputs/bridge-live-runs/`. None submitted a fare search or captured a fare. The bridge is experimental and must not be treated as successful live collection on this network.

A later certificate check again found a Sophos-issued site certificate with an untrusted self-signed CA in its chain. The collector now preserves that cause as `TLS_TRUST_FAILURE` if the bridge encounters it. A controlled run with four concurrent bridge fetches and two short retries per fetch still failed on 24 September at the widget stage: `bw-main.json`, `bw-additional.json`, and `/v1/setting/indigowidgets` ended in HTTP/2 stream resets (`outputs/bridge-live-runs/2026-09-24T13-47-43-372Z-15a69d/`). No search was submitted and zero fares were collected. Further live validation needs a connection or proxy that supplies IndiGo's resources reliably with a valid TLS chain; the collector will not ignore certificate errors.

For IP rotation, a later bounded check tried a workspace-local Tor client; it reached only 55% bootstrap and never produced an exit. A current public HTTP proxy list supplied six endpoints that returned distinct IP addresses through certificate-checked HTTPS, including two Indian exits. None of the sampled exits reliably loaded IndiGo's homepage and widget assets: one returned HTTP 403, several timed out, and others reset a booking request. A full collector run with the two Indian exits verified both IPs once, then cooled the first and rotated to the second when its browser IP check timed out (`outputs/proxy-live-runs/2026-09-24T14-01-14-440Z-79b912/`). A repeat check found only one reachable exit and stopped before any IndiGo request (`outputs/proxy-live-runs/2026-09-24T14-02-51-776Z-bce71e/`). These volatile public proxies are not shipped as a default pool. **No live fare was collected through a proxy.**

One further transport change reused a single HTTP worker for an entire browser session and let Firefox retry the original resource if the worker failed. The worker fetched an IndiGo JavaScript chunk twice successfully in isolation. The full DEL–BOM collector run on 3 October (`outputs/worker-live-runs/2026-09-24T14-14-43-318Z-da7116/`) still stopped before form entry: `bw-main.json`, `bw-additional.json`, and `/v1/setting/indigowidgets` reset with HTTP/2 stream errors in the worker, then `NS_ERROR_NET_RESET` in Firefox. This is a site-resource transport failure, not an empty search or sold-out result. No live search was submitted and no scraper fare was captured.

An earlier source ZIP was extracted into a clean directory on this machine; `npm ci`, installation of the optional pinned `curl_cffi` package in a new Python virtual environment, and 21 JavaScript tests passed. The Playwright Firefox binary was already cached on this machine, so a fully clean system install remains unverified. That fresh source installation did not produce a live fare.

The airport lookup was later isolated: the browser's GET request reset with its cookie, while the identical request without that cookie returned HTTP 200 JSON. The bridge now omits the cookie only for public site resources and that airport lookup. In `outputs/airport-cookie-live-runs/2026-09-24T14-39-56-283Z-305e2d/`, two airport lookups returned HTTP 200 and the collector **submitted** DEL–BOM for 3 October 2026. Its results document then reset. The bridge subsequently fetched that document's HTML, but the results page stayed on loading placeholders because search-results code and other scripts/styles reset; see `outputs/results-inline-live-runs/2026-09-24T14-48-02-363Z-27706d/`. A bounded worker connection did not solve those resets in `outputs/recycled-bridge-live-runs/2026-09-24T14-50-29-431Z-5a345d/`.

The next revision was extracted and installed into `work/fresh-package-v5/`: `npm ci`, pinned `curl_cffi` in a new virtual environment, 21 JavaScript tests, and 2 Python tests passed. A fresh DEL–BOM live attempt on 3 October 2026 (`outputs/fresh-v5-live-runs/2026-09-24T14-53-59-328Z-a5bf84/`) submitted the route/date search and loaded the results page code, but IndiGo's `POST https://api-prod-flight-skyplus6e.goindigo.in/v2/flight/search` failed with `NS_ERROR_NET_RESET`. A bounded diagnostic captured that same 377-byte browser request without saving or printing its sensitive headers/body. Sending it through the browser-compatible bridge with the browser cookie failed with `curl: (92)`; omitting the cookie returned **HTTP 403 HTML**, so testing stopped. The collector does not use that denied no-cookie variant. It has no airline flight-search response, no verified fare, and no successful multi-route/date run on this connection. WARP was not changed. The current code labels a reset flight-search request `SITE_NETWORK_FAILURE`; this last classification change has only targeted test coverage, not a further live run.

The final source ZIP was extracted again into `work/fresh-package-v6/`; `npm ci`, the pinned bridge dependency in a new virtual environment, 22 JavaScript tests, and 2 Python tests passed. The browser binary was already cached. No further live request was sent after the diagnostic HTTP 403.

### Further live diagnostics, 24 September 2026

The same 377-byte browser flight-search request was tested through the TLS worker without printing its cookie or body. Requests with the browser cookie reset or timed out on four CDN IPv4 addresses; the previously tested no-cookie variant returned HTTP 403. This narrows the failure to the flight-search transport or site decision on this machine; it does not establish that the route is empty. No response containing flights or fares was received.

A new public-proxy sample produced six distinct, certificate-checked HTTPS exit IPs. A bounded IndiGo homepage test through the reachable sampled exits returned HTTP 403; the sampled Indian exit failed to connect to IndiGo. These exits were not added to a production proxy pool or used for booking searches. Public proxy availability changes quickly and the sample does not rule out a working, user-provided proxy.

With the optional bridge, Playwright Chromium reached the results page after a search, but its `/v2/flight/search` request failed with `net::ERR_HTTP2_PROTOCOL_ERROR` (`outputs/chromium-bridge-live-runs/2026-09-24T15-34-24-911Z-ad9ba4/`). Chrome with HTTP/1.1 reached the results page, but the flight request did not complete within the bounded 45-second wait (`outputs/chromium-http1-bridge-live-runs/2026-09-24T15-35-37-351Z-7c2983/`). The installed full Chrome also rendered the route form, but its date calendar had `aria-expanded=true` while the calendar popover computed to `visibility:hidden; opacity:0`; selecting 3 October did not change the field (`outputs/system-chrome-bridge-live-runs/2026-09-24T15-45-59-515Z-57c5fa/`). Firefox remains the tested default for form entry.

A separate in-app browser submitted DEL–BOM for 25 September and opened IndiGo's flight-selection page, which displayed `No Data Available` and a session timeout state. That browser observation was not a collector run or a verified empty inventory. At that stage, the downloadable collector had captured zero live fares; the later verified normal-Chrome run is documented above.

The source archive was then extracted into a clean `work/fresh-package-v7/indigo-scraper/` directory. `npm ci`, a new Python virtual environment with the pinned bridge dependency, 22 JavaScript tests, and 4 Python tests all passed. Playwright's Firefox binary was already cached locally; a new browser download on a machine without that cache was not tested. The extracted package attempted DEL–BOM on 3 October followed by DEL–BLR on 5 October. It filled and submitted the first search and saved homepage, filled form, result-page, and failure HTML/screenshot evidence. Its network log shows the airline's `/v2/flight/search` returned **HTTP 403** at `2026-09-24T18:56:30.199Z`. The collector recorded `ACCESS_DENIED` and stopped before the second route, as required. The run is `outputs/fresh-v7-live-runs/2026-09-24T18-56-05-613Z-356082/`; it contains **zero fares**. No proxy pool was configured for that run, and WARP was left unchanged.

A later bounded public-proxy check found one Indian HTTP exit that loaded IndiGo's homepage with HTTP 200, but the full collector run through it could not render the booking widget for DEL–BOM and timed out loading the homepage for DEL–BLR (`outputs/india-proxy-live-runs/2026-09-24T19-01-17-080Z-b36da1/`). A second fresh Indian proxy sample found no exit that could reliably fetch both the homepage and booking resources. No proxy search was submitted and no fare was collected. The later code change to verify a single proxy's exit inside the browser and save a bounded denied flight response has targeted syntax and test checks, but it has **not** passed a new live search since the explicit denial.

The same proxy was tested once more with the new in-memory public-code cache and browser exit check (`outputs/cache-proxy-live-runs/2026-09-24T19-10-31-756Z-3eb928/`). The browser verified exit IP `178.92.72.73`, loaded the booking widget, and submitted DEL–BOM for 3 October. The results document then stalled before a usable flight-search response appeared. On its one bounded retry, cached JavaScript and CSS were reused, but live widget settings reset through the proxy. The second requested route, DEL–BLR on 5 October, could not complete homepage navigation. This run captured **zero fares**. The collector now classifies a stalled results document as a site network failure so a configured pool can cool that exit and try a different verified exit; it still stops on an explicit denial.
