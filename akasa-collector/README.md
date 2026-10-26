# Akasa Fare Desk

A local, direct Akasa website fare collector. It uses Chrome to submit the public booking form, saves the returned flight-search response and rendered result page, and shows a fare only when the route, date, flight, time, and displayed price agree. No paid API or airline credentials are needed. Failed searches remain failures. A retry creates a new run.

## First-time setup

This project needs Node.js 20 or newer, Git, and Google Chrome. This public repository does not require a GitHub login. It stores its browser profiles and run evidence
locally; those files are not included in the repository. Run the server in a
terminal and keep that terminal open while using the page.

### Ubuntu 22.04/24.04 (x86-64)

```bash
sudo apt update
sudo apt install -y curl ca-certificates wget git
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
wget -O /tmp/google-chrome-stable_current_amd64.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
sudo apt install -y /tmp/google-chrome-stable_current_amd64.deb
node --version
google-chrome --version
git clone https://github.com/nayan456123/airline-fare-collectors.git
cd airline-fare-collectors/akasa-collector
npm ci
./start.sh
```

The Chrome package above is for Ubuntu on x86-64. On another architecture, install a compatible Chrome/Chromium build and point `AKASA_CHROME_PATH` to its executable.

### Windows 10/11 (PowerShell)

Install Git, Node.js LTS, and Chrome. Then open a **new PowerShell
window** so the commands are available:

```powershell
winget install --id Git.Git -e
winget install --id OpenJS.NodeJS.LTS -e
winget install --id Google.Chrome -e
git clone https://github.com/nayan456123/airline-fare-collectors.git
cd airline-fare-collectors\akasa-collector
$env:AKASA_CHROME_PATH = "${env:ProgramFiles}\Google\Chrome\Application\chrome.exe"
node --version
npm ci
npm run web
```

Open **http://127.0.0.1:8788/**. Keep PowerShell open; press **Ctrl+C** to
stop. `start.sh` is for Bash, so use `npm run web` on Windows. If Chrome is
installed elsewhere, set `AKASA_CHROME_PATH` to the full `chrome.exe` path.
The Windows path is documented but has not been live-tested on this Ubuntu
development machine.

### macOS (Terminal)

Install [Homebrew](https://brew.sh/) first if needed, then install Node.js,
Git, and Chrome:

```bash
brew install node git
brew install --cask google-chrome
git clone https://github.com/nayan456123/airline-fare-collectors.git
cd airline-fare-collectors/akasa-collector
export AKASA_CHROME_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
node --version
npm ci
npm run web
```

Open **http://127.0.0.1:8788/**, keep Terminal open, and press **Ctrl+C** to
stop. macOS usage is documented but has not been live-tested on this Ubuntu
development machine.

### Run a direct terminal search

Use a future date. On Ubuntu:

```bash
travel_date=$(date -d '+5 days' +%F)
npm run collect -- --search "DEL:BOM:$travel_date" --headed
```

On macOS, use `travel_date=$(date -v+5d +%F)` and the same `npm` command. On
Windows PowerShell:

```powershell
$travelDate = (Get-Date).AddDays(5).ToString('yyyy-MM-dd')
npm run collect -- --search "DEL:BOM:$travelDate" --headed
```

Set `AKASA_CHROME_PATH` in that terminal before searching on Windows/macOS.
Use `--headless` if no graphical browser is available. The CLI saves runs in
`runs/`; the local page saves jobs in `web-runs/`.

Open `http://127.0.0.1:8788/` in a browser. Use the nine route shortcuts or add any airport-code pair, then select T+1, +5, +9, +15, +30, and/or +45. Choose 1–3 parallel workers and visible or headless Chrome; visible mode requires a graphical desktop. Workers have separate persistent Chrome profiles, with task starts at least 20 seconds apart. The page shows each task's agent, stages, live log, verified flight table, lowest displayed fare, price breakdown, and evidence. Stop interrupts a batch. The Recent run controls can retry one failed route/date or all eligible failed searches in a new run, preserving their original dates and browser mode. Access-denied searches are excluded. Delete run removes the selected finished run, its fares, logs, and evidence after an inline confirmation; active runs must be stopped first. New web runs and failed attempts are saved in `web-runs/`; terminal runs are saved in `runs/`. Set `AKASA_PROXY_SERVER=http://host:port` before `./start.sh` to use an existing proxy from the page.

Use `--headless` for background collection. The dedicated persistent Chrome profile is under `.session/`. Add `--proxy http://host:port` or `--proxy socks5://host:port` for an existing proxy; optional `--proxy-user` and `--proxy-password` are supported. No proxy is enabled unless configured. Set `AKASA_CHROME_PATH` if Chrome is installed at another path.

Verify any saved run independently:

```bash
node src/verify.mjs runs/RUN_DIRECTORY_NAME
npm test
```

Each run contains `manifest.json`, `events.ndjson`, and one folder per route/date. Each search folder has `result.json`, page HTML, screenshots, the raw flight-search response when received, and saved flight rows. A verified fare records its route, travel date, collection timestamp, flight, departure/arrival, starting price, itemized charges, and evidence filenames. `additionalWfe` is separate from the fare shown on the page; `fullTotal` includes it. The collector stops remaining searches on CAPTCHA, access denial, HTTP 429, or session expiry.

The local UI binds only to `127.0.0.1:8788`. It does not alter network settings or the sibling IndiGo collector. Parallel workers increase local browser load and airline traffic; a successful search depends on the live Akasa site and network. Access denial, CAPTCHA, rate limiting, and session expiry stop the batch rather than being reported as empty flights.

A flight card can show a revised time while crossing out the time in Akasa's flight response. The collector now records the displayed time and the response time separately, and the verifier accepts the difference only when the response time is explicitly crossed out in that same flight card. Flight, route, date, and fare still have to match. A response with zero exact-route journeys remains `EMPTY_RESULTS`; it is not described as sold out.

## Shared browser admission

Console/API jobs share browser slots with the other airline collectors installed on this computer. Below 8 GiB RAM, all three can accept jobs at the same time, but browser searches run one at a time and queued jobs display a waiting notice. At 8 GiB or more, at most three workers run across the collectors. Completed workers release admission; surviving workers retain their slot after a server crash. This prevents simultaneous browser pressure, not airline network errors or access challenges. Direct command-line collection is outside this console scheduler.
