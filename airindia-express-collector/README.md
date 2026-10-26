# Air India Express Fare Collector

A local collector for the official Air India Express booking site at
https://www.airindiaexpress.com/en/book-flights/. It submits route and date
searches in a headed browser by default and saves page and network evidence
locally. Its parser recognizes the observed official
`/b2c-flightsearch/v4/fsa` response and accepts fare rows only when the response
and exact-route rendered page rows agree. It requires one adult, INR, and
included taxes and fees; it reconciles the base and included charges against
the airline's fare totals. Nearby-airport page rows are excluded.

## Observed live checks — 9 October 2026

On the development computer's network, visible Chrome independently verified
20 exact-route DEL–BOM itineraries for 14 October. The lowest starting fare was
₹6,678 (₹4,880 base + ₹1,798 included charges). A second visible-Chrome search,
started through the dashboard, selected 23 November in the calendar and verified
22 DEL–BLR itineraries. Its lowest fare was ₹13,110 (₹10,501 + ₹2,609), on
IX1196 + IX1383. Those are timestamped observations, not current-price promises.

Headless selected and submitted the November route/date but failed before any
fare request: the anonymous-session `/aai-authentication/v2/auth/token` POST
received no response. The website canceled it after 10 seconds; the forwarder
then reached its 15-second timeout. One retry had the same result. Headless
collection is not claimed as working. Visible Chrome remains the default.

## Install and run

Requirements: Node.js 20 or newer, Git, and Google Chrome. These public source
downloads do not need a GitHub login. Keep the terminal open while the local
collector is running. Installation is separate from a successful airline
search; access challenges and network failures are recorded as failures.

### Ubuntu 22.04/24.04 (x86-64)

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl wget git
curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource-setup.sh
sudo -E bash /tmp/nodesource-setup.sh
sudo apt-get install -y nodejs
wget -q https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -O /tmp/google-chrome.deb
sudo apt-get install -y /tmp/google-chrome.deb
git clone https://github.com/nayan456123/airline-fare-collectors.git
cd airline-fare-collectors/airindia-express-collector
npm ci
npm run web
```

### Windows 10/11 (PowerShell)

```powershell
winget install --id Git.Git -e
winget install --id OpenJS.NodeJS.LTS -e
winget install --id Google.Chrome -e
```

Open a new PowerShell window after installation, then run:

```powershell
git clone https://github.com/nayan456123/airline-fare-collectors.git
Set-Location airline-fare-collectors\airindia-express-collector
npm ci
npm run web
```

Open **http://127.0.0.1:8791/** and keep PowerShell open. Press **Ctrl+C** to
stop the server. If Chrome is installed in a nonstandard location, set
`$env:AIX_CHROME_PATH` to the full path to `chrome.exe` before `npm run web`.

### macOS (Terminal)

Install [Homebrew](https://brew.sh/) if needed, then install Node.js, Git, and
Chrome:

```bash
brew install node git
brew install --cask google-chrome
git clone https://github.com/nayan456123/airline-fare-collectors.git
cd airline-fare-collectors/airindia-express-collector
npm ci
npm run web
```

Open **http://127.0.0.1:8791/**, keep Terminal open, and press **Ctrl+C** to
stop. If Chrome is in a nonstandard location, set `AIX_CHROME_PATH` to its
executable before starting.

Firefox is optional. Install its Playwright browser once with
`npx playwright install firefox`, then choose Firefox in the page or pass
`--browser firefox` to the collector. The `--disable-http2` option is available
for Chrome only; it can be selected per search/job and is not enabled by
default.

By default, accepted Air India Express HTTPS requests are freshly forwarded
through Playwright's built-in HTTP/1.1 client and the returned status, headers,
and body are passed back to the browser unchanged. Other hosts use the browser's
normal network path. This needs no Python installation. To use the browser's
native transport instead, pass `--http-transport native`; for example:

```sh
npm run collect -- --search DEL:BOM:YYYY-MM-DD --http-transport native
```

The collector retries selected transient failures once by default. Pass
`--retries 0` to disable that retry for a run.

Use `--renew-session` to clear Air India Express cookies before a run while
keeping the persistent browser profile. For a first-page transport failure,
the collector may clear those cookies once before its retry only when recorded
network evidence contains no HTTP 401, 403, or 429. It does not automatically
renew after an access denial, rate limit, expired session, or CAPTCHA. Do not
use `--renew-session` after a 401, 403, 429, or CAPTCHA challenge.

An existing proxy is optional. Set `AIX_PROXY_SERVER=http://host:port` or
`AIX_PROXY_SERVER=socks5://host:port` before starting the server, or pass
`--proxy` to terminal collection. Optional proxy authentication uses
`AIX_PROXY_USERNAME` and `AIX_PROXY_PASSWORD`; credentials are not written to
run manifests. Searches use the current connection when no proxy is set.

## Collection and evidence

The page accepts route pairs and the offered future-date offsets. It runs one
browser worker at a time, with at least 20 seconds between task launches.
Headed Chrome is the default; headless mode and Firefox can be selected.
Terminal collection is also available, for example:

```sh
npm run collect -- --search DEL:BOM:YYYY-MM-DD
```

Each browser uses a persistent profile under `.session/`. Run evidence is
stored locally under `runs/` for terminal searches and `web-runs/` for page
jobs. Evidence can include the submitted form, result/failure page, screenshots,
observed network metadata, and captured first-party JSON response bodies.
Every run records its build fingerprint, browser mode, and connected Wi-Fi
name when available. Transient loading failures receive one retry after a
recorded backoff; challenges and access denial receive no automatic retry.
These files can contain session or travel-search data; keep them local and do
not share them casually.

CAPTCHA, access denial, rate limiting, or session expiry blocks the batch and
stops queued searches. A missing or unrecognized response is a failure with
evidence, never an empty-flight result. A parser result alone does not establish
that a production search succeeded; saved response, exact-route page evidence,
and independent verification must all agree.

Run the local test suite with `npm test`.

Visible Chrome uses a dedicated ordinary Chrome process with a local CDP connection, following the existing Air India transport. Headless, Firefox, and configured proxy sessions use Playwright persistent contexts. Navigation, response capture, screenshots, and cleanup have bounded waits. A console worker has a four-minute outer deadline and records its last stage if the browser stalls. These protections do not establish live fare success.
