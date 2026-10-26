# Air India Fare Desk interaction contract

- Routes accept three-letter airport-code pairs and may be chosen from ten Ministry Category I shortcuts.
- Date offsets are computed in the India time zone when a run starts; retries retain the saved travel date.
- One to three requested workers use separate persistent profiles. The desk refuses to start a batch or retry below its available-memory floor, otherwise reduces active workers when needed, shows the effective count, and keeps all searches queued. Launches are staggered. A stopped or blocked run never sends queued searches.
- Progress stages describe observed actions only. A submitted search is not a result, and a result is not a verified fare.
- Each attempt, including failures, is saved. A failed search displays its exact cause and any available saved page, screenshot, and booking response.
- A fare row requires the airline response and rendered page to agree on the requested route and date, flight, and displayed fare. Missing price components render as unavailable.
- Retry creates a new saved run for one eligible search. Access denial, CAPTCHA, rate limits, and expired sessions disable retry until access changes.
- Stop interrupts the active batch and marks remaining searches as skipped or interrupted.
- The interface never treats failure as sold out and never inserts promotional, fixture, or cached prices into the fare table.
