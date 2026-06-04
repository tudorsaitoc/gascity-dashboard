# Product

## Register

product

## Users

A single operator — the maintainer of the `ds-research` Gas City workspace —
who keeps this dashboard open in a peripheral tab while doing other work
across a MacBook (via SSH port-forward) and occasionally the host console
directly. Two modes of use coexist:

- **Ambient glance**, several times an hour, between other tasks.
  The question is "is anything off?" not "show me everything."
- **Triggered investigation**, when something _is_ off — a stuck agent,
  a memory spike, a bead that didn't get claimed. Full attention,
  needs the answer fast.

The dashboard sits between her editor and her ongoing work on Gas City
itself, so it has to coexist with a dev environment without competing
for attention.

## Product Purpose

A calm, opinionated cockpit for a single Gas City operator. Surfaces
the things she actually checks — Agents, Beads, Mail, Health — in a
way that prioritises _what's interesting right now_
over _all available information_.

Success: she can answer "is anything off?" in under a second from
peripheral vision, and "what's happening with X?" in two clicks.

Agents and Health are the top-tier views; Beads and Mail
are secondary surfaces visited deliberately.

## Brand Personality

**Considered, literary, instrumental.**

- _Considered_ — every element earns its place. Numbers are typeset,
  not boxed.
- _Literary_ — bookish typography. Headings carry weight, whitespace
  is structural, the hierarchy comes from type. The page reads like a
  thoughtfully-set page, even when it's full of numbers.
- _Instrumental_ — it's a tool, not a poster. The aesthetic serves the
  reading, the reading serves the operating.

Reference flavour: the _FT Edit_ app, _NYT Cooking_ in its quiet moments,
_Are.na_. Bookish but not ornamental. Confident, not loud.

## Anti-references

- **Datadog, Grafana, Splunk.** Information theatre: every dashboard tries
  to show everything, every chart competes with every other chart, density
  pretends to be insight. The opposite of what an ambient tab needs.
- **Linear, Vercel, Resend.** Dark slate + neon accent + perfectly-rounded
  cards: the visual default for every developer tool in 2026. Citadel
  already drifts toward this. We will explicitly _not_ go there.
- **Glassmorphism and big gradient hero metrics.** SaaS cliché. Even more
  out of place here because the data is the point.
- **Identical card grids of "five KPIs across the top."** The hero-metric
  template. We have five views, not five KPIs.

## Design Principles

These principles set the direction; `DESIGN.md` is the binding visual contract that operationalizes them into the concrete palette, typography, elevation, and named rules. Defer to it for any visual, typographic, copy, or component decision.

1. **Quiet by default, loud on demand.** Nothing should pull the eye unless
   something is wrong. Anomalies — a stuck agent, a memory ceiling, a
   failing supervisor — earn the only visual emphasis on the page.

2. **Typeset numbers, not chart-junk.** Numbers are typeset like the rest
   of the page — tabular numerals, deliberate scale, aligned columns. Reserve
   charts and bars for genuine time-series; static state should read as type.

3. **Earn every line.** Hairlines, dividers, and chrome are taxes on the
   reader's attention. Replace borders with whitespace whenever the
   structure is already legible.

4. **Typography carries the hierarchy.** Size and weight do the work cards
   would otherwise do. Headings are typeset, not boxed. Sections are
   separated by rhythm, not by container.

5. **Status is a sentence, not a swatch.** Health is a paragraph the
   operator can read. Color is a last-resort emphasis, not a primary
   carrier of meaning — passes WCAG even in greyscale.

## Accessibility & Inclusion

- Target **WCAG 2.2 AA** on both themes.
- **Light default, dark optional.** Editorial-typographic register works
  best in light; dark mode is offered for late-night work and respects
  the operator's chosen theme across sessions.
- **Status not carried by color alone** — every red/amber/green pairs
  with a glyph, a word, or a position. Greyscale must remain readable.
- **Respect `prefers-reduced-motion`** — SSE-driven updates fade in
  instead of sliding, no animated chart transitions.
- **Tabular numerals** so number columns are scannable without zoom.
- **Keyboard navigation across all five views** — primary actions
  (claim, close, nudge, peek) reachable without the mouse.
