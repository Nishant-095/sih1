# Air India Express Fare Collector interaction contract

- The collector targets the official Air India Express booking page. Routes
  accept `AAA-BBB`, `AAA:BBB`, or `AAA→BBB`; dates use the offered offsets
  T+1, +5, +9, +15, +30, and +45 in Asia/Kolkata. A batch is limited to 54
  route/date searches.
- Only one batch may run at a time. The web scheduler admits one worker, and
  starts successive searches at least 20 seconds apart. Headed Chrome is the
  default. Headless mode and Firefox are selectable. Chrome's HTTP/2 disabling
  switch applies per job and is unavailable for Firefox.
- Each browser uses a persistent profile. The UI reports progress and each
  search's status. Stop interrupts active work and preserves attempted
  evidence. CAPTCHA, access denial, rate limiting, and expired sessions block
  the batch and prevent queued searches from starting.
- A fare may appear only after a supported AIX response schema is parsed and
  independently checked against the submitted route/date and rendered result
  evidence. The AIX response schema is currently uncalibrated, so the parser
  accepts no fare rows. A submitted search without verified rows is not a
  successful fare search and must not be represented as sold out.
- Evidence controls expose saved local pages, screenshots, and captured
  response/network evidence. Saved page HTML is evidence only; the local app
  must not execute it.
- Keep status and failure information readable, announce updates to assistive
  technology, preserve keyboard focus during refreshes, and keep actions usable
  on narrow screens.
