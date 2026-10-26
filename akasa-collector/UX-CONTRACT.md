# Akasa Fare Desk interaction contract

- Routes use `AAA-BBB` or `AAA:BBB`, one per line. Ten shortcut routes match the IndiGo Fare Desk, and custom pairs can be entered. Day offsets are future calendar days in Asia/Kolkata: T+1, +5, +9, +15, +30, +45. Submit validates both and caps a batch at 36 searches.
- One active collection at a time. The user chooses 1–3 parallel workers and background or visible Chrome; retries preserve the original mode. Every worker has a separate persistent profile and starts are at least 20 seconds apart. The button disables while a run is active; Stop interrupts active workers and preserves their attempted evidence. Each search has visible stage and explicit success, failure, blocked, skipped, or running status.
- Retry appears only for a failed, partial, or skipped search. It creates a separate live run for that exact route and date. It never rewrites the original failure.
- A fare appears only when the saved airline response and page row agree and the independent verifier passes. Show displayed starting fare, base, included taxes, additional WFE, and full calculated total; mark the lowest displayed starting fare among verified flights.
- Evidence links download the saved page, screenshot, and airline response. They never execute airline page HTML in the local app.
- Status changes use a polite live region; failure details remain readable. Keyboard focus stays on controls when content refreshes. Narrow screens keep all actions visible.
