---
version: alpha
name: "IndiGo Fare Desk"
description: "A calm local flight-research console that makes each search and its evidence legible."
colors:
  primary: "#102fa5"
  ink: "#102064"
  background: "#f4f7fb"
  surface: "#ffffff"
  line: "#dbe4f4"
  success: "#0c8d69"
  failure: "#ba3b4b"
typography:
  sans:
    fontFamily: "Inter, Segoe UI, Arial, sans-serif"
rounded:
  card: "16px"
  control: "10px"
omitted:
  - section: mono
    reason: "Airport codes use the primary sans family with letter spacing."
---

# Visual direction

The page is a local operations desk, with airline-blue structure, white working surfaces, and small green or red status cues. The animated route line represents travel; progress bars advance only on real collector stages. There is one primary action. Search status, cause, verified fares, and evidence remain readable without opening logs. Avoid simulated prices, generic analytics charts, and decorative status animation that implies progress when none occurred.

# Layout and behavior

Use one screen with route/date setup above the current run. Cards stay in request order. At phone width, route and date controls stack, and the stage list wraps while retaining every stage name. Controls are native and keyboard accessible. The active stage pulses only when motion is allowed. Failure text is persistent and visible; it is never represented by color alone.
