# DealOrchestra — Project Agent Instructions
*Shared project context. Read this before any session.*

Before starting any task, read DO_KIMI_VSCODE_BRIEFING.md in this directory.

---

## What This Product Is

DealOrchestra is a **Deal Relationship Management (DRM) system** — not a CRM. The distinction is structural: in a CRM, the contact is the primary entity and deals are attached to people. In DealOrchestra, the deal is the primary entity and people live inside deals.

*"In DealOrchestra, the deal comes first. Everything else lives inside it."*

Built for commodity trading intermediaries and bilateral transaction businesses (gold, bank instruments, property, recruitment). Target team size: 1–30 users. Current user: single operator, production data, live deals.

This is a commercial product in active use, not a prototype.

---

## Technology Stack — Read This Carefully

**This is not a standard React project. Do not treat it as one.**

| Layer | Reality |
|-------|---------|
| Runtime | Single self-contained `.html` file deployed to Netlify via drag-and-drop |
| JavaScript | Raw JSX inside `<script type="text/babel">` — Babel Standalone transpiles in the browser at runtime |
| React | Loaded from CDN. React hooks destructured at module level: `const { useState, useEffect, useCallback, useRef, useReducer } = React;` |
| Build | `@babel/preset-react` classic runtime only. **Never `@babel/preset-env`** — it outputs CommonJS `require()` that breaks in browser script tags |
| CSS | **Inline styles only, as JS objects with camelCase properties.** No CSS files, no CSS modules, no Tailwind, no external stylesheets |
| Database | Supabase PostgreSQL via custom `sb` helper (direct PostgREST calls). **Not the Supabase JS SDK** |
| Icons | Tabler Icons webfont (`ti ti-*` class pattern) — must be loaded in the HTML wrapper or all icons render as blank space |
| Typography | Plus Jakarta Sans, Google Fonts CDN, weights 300 / 400 / 600 only |
| IDs | Client-generated via `genId()` (`Math.random().toString(36).substr(2, 9)`). No Supabase sequences |

**There is no npm, no node_modules, no module bundler, no component files, no separate CSS files.** Everything is one `.jsx` source file assembled into one `.html` file. Code that assumes a modern module system will not work.

---

## Absolute Code Rules

These are non-negotiable. Violating them causes either silent failures or architectural regressions.

**1. Never use `<button>` elements.**
All interactive elements use `<span>` with `onClick`. No exceptions.
```jsx
// Wrong
<button onClick={handleSave}>Save</button>
// Correct
<span onClick={handleSave} style={{ cursor: "pointer" }}>Save</span>
```

**2. Never use `@babel/preset-env`.**
It produces CommonJS output that breaks in `<script>` tags without a bundler.

**3. Never add `useEffect` with state dependencies near the storage layer.**
Storage effects must fire exactly once on mount via a `useRef` guard. This caused a data loss incident.

**4. Never auto-create a task when a card is created.**
A card is not a task. Tasks only exist when a user explicitly creates one. This was a root-cause bug that required a live data migration to fix.

**5. The `journal` table has no `created_at` column.**
Always use `order=date.desc`. Never `order=created_at.desc` on this table.

**6. Deliver HTML before JSX.**
Always produce and test the Netlify HTML file first. Present JSX source only after HTML is confirmed working.

**7. One version per build.**
Bump the version number for every change. `const VERSION = "v9.3.XX"` must match the filename. A broken build and its fix must have different version numbers. Never reuse a number.

**8. All meta-position glyphs must carry hover text.**
Every icon, star cluster, or glyph used as a standalone action must have a `title` attribute with a plain English description.

---

## Design Principles

**The board is a three-column solitaire pipeline** (Leads / Potential / Active) with portrait playing card proportions (5:7 ratio). Cards fan-stack within columns sorted by urgency. This interaction paradigm — hover to peek, click to select, click to flip and expand, click away to auto-return — applies to every entity type in the product. It is the product's market differentiator. Do not weaken it.

**Cards feel like physical objects.** Glassmorphism gradient surface: near-transparent at top, colour pools at base. Back face inverts: colour at top, dissipates down. Corner radius 20–22px. Inset top-edge highlight creates physical thickness.

**Object permanence.** Cards never disappear and are replaced by modals. They transform in place.

**Animations use mechanical precision.** Never spring physics, never bouncy easing. Specific timings are locked (flip animation has five phases with exact millisecond values — see design documents). Do not change timings without the design document open.

**Typography hierarchy through weight and colour, not scale.**
- Weight 300 — metadata, facts, muted secondary information
- Weight 400 — names, body text, primary content  
- Weight 600 — section labels only
- Never heavier than 600. Never `font-weight: bold` on card content.

**Dividers over boxes.** Hairline `border-bottom: 0.5px solid` separates items. No background tints, no bordered containers around individual data rows.

**Icons with tooltips over labelled pills.** Per-item metadata is a small icon circle with hover tooltip — not a bordered pill capsule.

**Plain coloured text over badges.** Status, priority, and state shown as plain text in semantic colour. No bordered badge.

**Semantic colour signals (immutable):**
- Red = overdue
- Amber = potential / today
- Green = active / progressing
- Grey = unmatched / neutral

**Heat (🔥) and Priority (asterisks) are distinct signals, never conflated.**
- Heat = opportunity quality (board cards, flame emoji, never substitute)
- Priority = action urgency (tasks, asterisk system: `***` urgent / `**` high / `*` normal)

---

## Supabase — Key Facts

Connection: direct PostgREST via custom `sb` helper. Auth: anon key (no RLS yet — v10 work). IDs: client-generated strings.

Tables: `deals`, `deal_sellers`, `sellers`, `buyers`, `people`, `tasks`, `thread_entries`, `documents` (legacy), `journal`.

**Schema additive changes:** always use `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`. Never ad-hoc to production once v10 staging is in place.

Full schema is in `DO_AGENT_TECHNICAL.md`.

---

## Versioning and Assembly

- Source: `dealorchist_vX.X.X.jsx`
- Output: `dealorchist_vX.X.X_netlify.html`
- Assembly: copy wrapper verbatim from previous working HTML (do not reconstruct) + raw JSX + footer. Wrapper must include Tabler webfont, Plus Jakarta Sans, and React hooks destructure.
- Validate: babel-compile the JSX, then `new Function(code)` syntax check. Repeat on extracted HTML script body.
- Version in source must match filename: `const VERSION = "v9.3.102";`

---

## What This Product Is Not

- Not a marketing tool (no email sequences, drip campaigns, lead scoring)
- Not a communication platform (logs that calls happened, does not place them)
- Not a project management system (tasks support deals, nothing else)
- Not an accounting tool
- Not a document creation or signing tool
- Not a BI or data warehouse tool
- Not an enterprise CTRM (Aspect, Agiboo, ION Trading territory)
- **Private tasks are explicitly out of scope at any version**

---

*For full design decisions, schema, and roadmap: read the DO_AGENT_* document set.*

## Workflow — how Claude and Kimi work together
Before starting any task in this project, read DO_KIMI_VSCODE_BRIEFING.md 
in this directory. It explains the two-tool workflow, ground rules, locked 
design decisions, and what to build next. The master design spec is 
DEALORCHESTRA_MASTER_SPEC.md — add this to the root when Ken provides it.