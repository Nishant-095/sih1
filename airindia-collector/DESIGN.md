# Air India Fare Desk design context

The desk follows the IndiGo and Akasa collector workflow: plan routes and dates, watch individual worker stages, inspect verified fare rows and saved evidence, and retry one failed route/date when access permits. Air India has its own red and plum palette, while preserving the sibling desks' compact local research-tool feel.

The central trust rule is visible in the product: **a saved attempt is not a verified fare**. The UI separates queued, searching, blocked, failed, skipped, and verified states. A failure card shows its cause and saved page or screenshot; no price appears without independent airline-response and rendered-page agreement.

The product is desktop-first but usable on mobile. Tables scroll horizontally on narrow screens. Native form controls, visible error text, keyboard focus, and reduced-motion behavior remain part of the design. The interface runs locally on port 8789 and does not imply that the airline has granted search access.
