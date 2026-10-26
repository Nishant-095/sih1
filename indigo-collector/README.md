# IndiGo Collector

A local browser-driven tool for collecting current fares directly from IndiGo's public booking website. No paid API, account, or credentials are required. The page lists every verified flight for a route and date, including the lowest displayed starting fare for each flight and its base fare and tax/fee breakdown. Failed searches are recorded as failures, never as sold-out results.

## Start it whenever you want

```bash
cd /path/to/airline-fare-collectors/indigo-collector
./start.sh
```

Open **http://127.0.0.1:8787/** in your browser. Enter routes such as `DEL-BOM` and `DEL-BLR`, select any of T+1, T+5, T+9, T+15, T+30, or T+45, choose Visible Chrome or Headless Chrome, and click **Collect all flights**. The page shows each worker's progress and saved evidence. You can start a run whenever you want; there is no app-enforced daily quota. Its searches are paced and access denial/CAPTCHA stops the queue.

For a failed or interrupted card, click **Retry this search**. For a skipped card, click **Run this search**. This starts only that saved route and exact travel date in a new run, keeps the original evidence, and uses the original browser mode. If IndiGo denied access or the date has passed, start a new collection after the issue is resolved.

The **Recent run** controls also offer **Retry failed searches** when the selected saved run has retryable future searches. It submits them together as one new batch, preserves the exact original dates and browser mode, and leaves the original run evidence intact. Access denial is never retried automatically. **Delete run** removes a selected finished run, including its fares, logs, and evidence, after an inline confirmation. Stop an active run before deleting it.

Keep the terminal running while using the page. Press **Ctrl+C** there to stop the server. If it is already running, open the URL; `./start.sh` will also tell you that it is already running.

## First-time setup

This project needs Node.js 20 or newer, Git, and Google Chrome. This public repository does not require a GitHub login. Downloading the code does **not**
include your old fares, browser profiles, or proxy settings. They remain on the
original computer. On all systems, run the server in a terminal and keep that
terminal open while using the page. `npm ci` installs the exact versions in
`package-lock.json`.

### Ubuntu 22.04/24.04 (x86-64)

Use Ubuntu x86-64 with Node.js 20+ and Google Chrome. On a fresh machine:

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl wget git
curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/indigo-nodesource-setup.sh
sudo -E bash /tmp/indigo-nodesource-setup.sh
sudo apt-get install -y nodejs
wget -q https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -O /tmp/indigo-chrome.deb
sudo apt-get install -y /tmp/indigo-chrome.deb
git clone https://github.com/nayan456123/airline-fare-collectors.git
cd airline-fare-collectors/indigo-collector
npm ci
./start.sh
```

A graphical desktop is needed for Visible Chrome. Headless Chrome runs without one. Browser access depends on IndiGo and the current network; installation alone does not guarantee fares.

### Windows 10/11 (PowerShell)

Install Git, Node.js LTS, and Google Chrome with `winget`, then open a
**new PowerShell window** so their commands are on `PATH`:

```powershell
winget install --id Git.Git -e
winget install --id OpenJS.NodeJS.LTS -e
winget install --id Google.Chrome -e
```

Clone the public repository and start the local page. Change the Chrome path
if Chrome was installed elsewhere:

```powershell
git clone https://github.com/nayan456123/airline-fare-collectors.git
cd airline-fare-collectors\indigo-collector
$env:INDIGO_CHROME_PATH = "${env:ProgramFiles}\Google\Chrome\Application\chrome.exe"
node --version
npm ci
npm run web
```

Open **http://127.0.0.1:8787/**. Keep PowerShell open. Press **Ctrl+C** to
stop. On Windows, use `npm run web`; `start.sh` is a Bash script. If the default
Chrome path is missing, find `chrome.exe` in your Chrome installation and set
`INDIGO_CHROME_PATH` to that full path. The Windows path is documented but has
not been live-tested on this Ubuntu development machine.

### macOS (Terminal)

Install [Homebrew](https://brew.sh/) first if needed, then install Node.js,
Git, and Chrome. These commands work on Apple silicon and Intel Macs:

```bash
brew install node git
brew install --cask google-chrome
git clone https://github.com/nayan456123/airline-fare-collectors.git
cd airline-fare-collectors/indigo-collector
export INDIGO_CHROME_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
node --version
npm ci
npm run web
```

Open **http://127.0.0.1:8787/**, keep Terminal open, and press **Ctrl+C** to
stop. macOS usage is documented but has not been live-tested on this Ubuntu
development machine.

### Run a direct terminal search

From `indigo-collector`, choose a **future** date. On Ubuntu:

```bash
travel_date=$(date -d '+5 days' +%F)
npm run collect:chrome -- --search "DEL:BOM:$travel_date" --all-flights
```

On macOS, use `travel_date=$(date -v+5d +%F)` and the same `npm` command. On
Windows PowerShell:

```powershell
$travelDate = (Get-Date).AddDays(5).ToString('yyyy-MM-dd')
npm run collect:chrome -- --search "DEL:BOM:$travelDate" --all-flights
```

Set `INDIGO_CHROME_PATH` in that terminal before the search on Windows/macOS.
The CLI saves each run under `runs/`; the local page saves jobs under
`web-runs/`. A failed search is not a sold-out result.

## Evidence and advanced use

- `web-runs/` contains each page run, its route/date, collection time, fares, logs, page screenshots/HTML, and airline response evidence.
- `evidence/production-2026-09-27/` contains a separate verified three-search direct-Chrome cohort across DEL-BOM and DEL-BLR. Historical fares are observations from that date, not current quotes.
- `.session/web-agents/` holds persistent Chrome profiles for the page. Keep it if you want session continuity.
- `npm test` runs the complete local test suite. `npm run verify:runs -- /absolute/path/to/a/run` validates saved evidence.
- To use an unauthenticated HTTP/HTTPS/SOCKS5 proxy for the page, start with `INDIGO_PROXY_SERVER=http://host:port ./start.sh`. The page uses that one proxy for the run; the CLI's separate proxy-pool option is documented in [technical history](docs/technical-history.md). No fare collection through a proxy has been verified.

The page binds to this computer only. It stops on CAPTCHA or explicit access denial, and records empty or failed responses without inventing prices. Source and architecture notes are in [RELIABILITY.md](RELIABILITY.md), [DESIGN.md](DESIGN.md), and [UX-CONTRACT.md](UX-CONTRACT.md).

### Persistent Chrome workers

Console/dashboard jobs now keep one Chrome process, browser context, and search tab alive per worker throughout the batch. Every query still saves a separate timestamped run and passes the same fare/page/response evidence verifier. The shared browser slot stays reserved until that worker closes; jobs from another airline may wait while its Chrome is alive.

Visible and headless modes use the same dedicated worker profile at `.session/web-agents/headed/agent-N` (the directory name is historical). This removes the old difference in session state between modes. The previous `headless-ua-v1` profile is retained on disk. A denied worker refuses subsequent commands and closes after its failure evidence is saved; there is no automatic profile clearing or proxy rotation on denial.

Before submission, the collector waits for document completion and pending booking token validation/refresh requests to settle. Browser environment metadata, Chrome process ID, worker session ID, and search number are recorded to check actual reuse. This improves lifecycle consistency; it does not establish that IndiGo accepts every request.

For an isolated mode comparison, close the collector browser first and run:

```bash
node scripts/compare-chrome-modes.mjs --base-profile .session/web-agents/headed/agent-1 --search DEL:BOM:YYYY-MM-DD
```

Choose a future date. The script copies the same starting profile to two private diagnostic profiles, runs one search per mode, observes shared browser admission, and saves results under `runs/mode-comparison-*`. These are diagnostic searches, not production reliability samples.

### Search pacing and access failures

Console/dashboard searches have a 20-second launch gap **and a 20-second rest after a worker finishes**. After six launched searches, the scheduler rests for 90 seconds after the last worker finishes. These are conservative local settings, not published IndiGo limits. Timing is saved in `web-runs/.search-pacing.json`, so a new batch or server restart does not remove a pending rest. Queued searches display the next scheduled start. This affects console/dashboard jobs; independent CLI invocations are not coordinated by this scheduler.

An HTTP 403 is an actual server rejection, even when Chrome reports a CORS `net::ERR_FAILED`. The collector preserves completed fares, stops the batch, and labels unsent searches as skipped. It does not rotate proxies or retry a denied request. CDP diagnostics now save request/header shape, body hashes, public rejection metadata, and the real HTTP status without saving raw authorization values or cookies. Pacing reduces request pressure; it cannot guarantee that the airline will accept every future search.

Live check on 9 October 2026 after the worker change: **Headless Chrome (persistent session)** completed four console searches across DEL–BOM and DEL–BLR, for 10 October and 23 November, saving **259 verified fare records**. All four used one Chrome process and worker session, with separate page/response evidence per query. A controlled diagnostic comparison also succeeded in both modes from copies of the same starting profile. This verifies the tested batch, not a long-term acceptance rate. See [the current evidence report](docs/headless-worker-2026-10-09.md); [the earlier diagnosis](docs/reliability-2026-10-09.md) records the prior HTTP 403 failures.

Calendar recovery: the collector accepts an exact date already selected, checks the two visible month headings before navigating, clicks the date's calendar button, and, if the next-month arrow does not move, selects the last day of the right-hand month and reopens the picker. A browser test covers the stalled-arrow path. The 9 October headless worker batch also verified live T+45 searches on 23 November for both DEL–BOM and DEL–BLR. Failed searches remain failures, not sold-out results.

## Shared browser admission

Console/API jobs share browser slots with the other airline collectors installed on this computer. Below 8 GiB RAM, all three can accept jobs at the same time, but browser searches run one at a time and queued jobs display a waiting notice. At 8 GiB or more, at most three workers run across the collectors. Completed workers release admission; surviving workers retain their slot after a server crash. This prevents simultaneous browser pressure, not airline network errors or access challenges. Direct command-line collection is outside this console scheduler.
