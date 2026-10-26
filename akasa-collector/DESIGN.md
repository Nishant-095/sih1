# Akasa Fare Desk design

## North star
An operational flight-search desk for one person collecting direct Akasa fares. Every task makes the route, travel date, live state, and evidence visible. Failed searches stay failures.

## Visual direction
Deep violet `#251052`, electric violet `#6735db`, Akasa orange `#ff7b30`, near-white `#f8f7fb`, ink `#1e1930`, muted `#6d6682`. The signature is a route line across each search card, with stage markers that move as a real search progresses. Body uses system sans; data uses a tabular sans stack. Strong focus outlines and reduced-motion handling apply throughout.

## Behavior owners
The one-screen app owns its route form, ten route shortcuts, six date offsets, worker count, recent-run picker, Stop action, live task cards, evidence links, and single-search retry. Native form controls own keyboard behavior. `src/collect.mjs` is the only live-search engine; `src/web-jobs.mjs` schedules one collector process per route/date. The verifier owns the definition of a proven fare.

## Constraints
The app binds to localhost. A batch has 1–3 workers with separate persistent browser profiles and at least 20 seconds between task starts. One failed search may be retried as a new recorded run. A denial stops queued tasks and interrupts other active workers. Raw airline response and page evidence download as files. The interface never maps a failed request to sold-out status.
