# DealOrchestra Master Spec
**Last updated:** 20 July 2026
**Version:** 1.0
**Status:** Living document — always current. One file, updated in place. Git tracks history.

---

## How to use this document

This is the single source of truth for DealOrchestra. Every decision about what the product is, how it looks, how it behaves, and what gets built next is recorded here.

- **Claude** reads this at the start of every design session to know current state
- **Kimi Web** reads this before producing any build instructions
- **Kimi VS Code** receives instructions derived from this document
- **No decision is locked until it is recorded here**
- **When this document and any other source conflict, this document wins**

---

## 1. What DealOrchestra Is

### Product identity
DealOrchestra is a **Deal Relationship Management (DRM) system** — not a CRM. The distinction is structural, not cosmetic.

| CRM | DRM (DealOrchestra) |
|-----|---------------------|
| Contact is the primary entity | Deal is the primary entity |
| People live at top level; deals attached to people | People live inside deals |
| Designed for relationship management over time | Designed for transaction execution in motion |

*"In DealOrchestra, the deal comes first. Everything else lives inside it."*

**Positioning:** "Most tools are built around people. DealOrchestra is built around deals."

### Target market
Small commercial teams of 1–30 users in bilateral transaction businesses — commodity trading, physical gold and metals brokerage, bank instrument trading, property brokerage, recruitment, freight forwarding, business acquisition, wholesale trade.

Pricing model: £5/user/month, minimum 3 users.

### What DealOrchestra is not
Not a marketing tool. Not a communication platform. Not a project management tool. Not an accounting tool. Not a document creation tool. Not an enterprise CTRM system. Not a data warehouse.

### Company
Built by Ken, sole developer and product owner, operating as EasyGold.

---

## 2. Technical Architecture

### Stack
- **Frontend:** Single-file React/JSX, Babel Standalone (CDN), no build tooling, inline styles only
- **Backend:** Supabase PostgreSQL, direct PostgREST via custom `sb` helper (not the Supabase JS client)
- **Deployment:** Netlify drag-and-drop of compiled HTML file
- **Assembly:** `assemble_netlify.py` Python script derives title from version argument
- **Icons:** Tabler Icons webfont via CDN (must be present in HTML wrapper)
- **Font:** Plus Jakarta Sans via Google Fonts CDN

### Key schema tables
`deals`, `deal_sellers`, `sellers`, `buyers`, `people`, `tasks` (with `subtasks` JSONB array and `chase_note`), `thread_entries` (with `entry_type`), `documents`, `journal`

### Supabase project
`https://ponmgyurofsthaxnrvfd.supabase.co`

### Versioning convention
`dealorchist_vX.X.X.jsx` and `dealorchist_vX.X.X_netlify.html`. The `VERSION` constant inside the JSX matches the filename. Never reuse a version number.

### Current build
v9.3.102 — stable, in active use. No changes in this phase.

### Version control
GitHub — not yet set up. First task before any v10 code is written. Non-negotiable.

---

## 3. UI Design — Core Principles

### The interaction paradigm
DealOrchestra uses a **unified physical card interaction grammar** across every screen. The board is a solitaire pipeline of playing cards. One set of gestures applies everywhere — deals, tasks, contacts, calendar events, registries. A user who learns the card gesture on day one already knows how to interact with every other entity.

### Object permanence
Cards never disappear and are replaced by modals. They transform while preserving spatial identity. This applies to every interaction in the product without exception.

### Typography
**Plus Jakarta Sans** throughout. Loaded from Google Fonts.
- Weight 300 — metadata, facts lines, secondary text
- Weight 400 — names, body text, seller names (never bold)
- Weight 500 — emphasis only where absolutely necessary
- Weight 600 — section labels, topbar elements only
- Never heavier than 600 anywhere

### Canvas
`background: #f8f7f4` — near-white with barely perceptible warm tint. Not pure white, not grey. The canvas is a felt surface that holds the cards. It must never compete with the cards for attention. The elaborate dual-wash gradient explored earlier was deliberately rejected.

### Colour system — semantic (immutable)
These colours never change regardless of which user palette is active:
- Red `#c0392b` — overdue
- Amber `#b87a18` — due today
- Green `#2e7d52` — active/progressing
- Grey `#b0a888` — unmatched/no action

### Colour system — card type
- Honey/amber gradient — Lead cards
- Mint/green gradient — Active cards

### What is permanently removed
- Left accent bar on cards — gone, never returns
- Black/dark header on card back face — rejected, colour carries through
- Chips on facts lines — rejected, plain dot-separated text only
- Elaborate dual-wash board canvas — rejected

---

## 4. UI Design — The Card

### Dimensions
- Width: `185px` in reference; scales with column width on board
- Aspect ratio: `5 / 7.6` (portrait playing card proportions)
- Border radius: `22px`
- Font: Plus Jakarta Sans throughout

### Front face — glass gradient surface

The card surface is glassmorphism-influenced. Near-transparent at top (canvas shows through), colour pools and intensifies at base. Inset top-edge highlight gives physical thickness.

**Box shadow (all states):**
```css
box-shadow: inset 0 1.5px 0 rgba(255,255,255,0.9),
            inset 0 -1px 0 rgba(255,255,255,0.15),
            0 4px 24px rgba(160,130,50,0.13),
            0 1px 4px rgba(0,0,0,0.05);
border: 1px solid rgba(255,255,255,0.62);
```

**Lead card gradient:**
```css
background: linear-gradient(175deg,
  rgba(255,255,255,0.18)  0%,
  rgba(255,255,255,0.32) 18%,
  rgba(255,252,240,0.55) 38%,
  rgba(252,240,195,0.78) 62%,
  rgba(245,224,140,0.92) 82%,
  rgba(236,208,100,0.97) 100%);
```

**Active card gradient:**
```css
background: linear-gradient(175deg,
  rgba(255,255,255,0.18)  0%,
  rgba(255,255,255,0.32) 18%,
  rgba(242,255,248,0.55) 38%,
  rgba(210,242,224,0.78) 62%,
  rgba(158,228,192,0.92) 82%,
  rgba(118,210,162,0.97) 100%);
```

**Lead card hover blush:**
```css
background: linear-gradient(175deg,
  rgba(255,248,235,0.32)  0%,
  rgba(255,245,220,0.52) 22%,
  rgba(253,238,190,0.74) 52%,
  rgba(247,224,148,0.90) 78%,
  rgba(240,210,110,0.97) 100%);
box-shadow: inset 0 1.5px 0 rgba(255,255,255,0.9),
            0 18px 42px rgba(196,92,0,0.16),
            0 4px 12px rgba(0,0,0,0.08);
```

**Active card hover blush:**
```css
background: linear-gradient(175deg,
  rgba(240,255,247,0.32)  0%,
  rgba(225,248,235,0.52) 22%,
  rgba(198,238,215,0.74) 52%,
  rgba(170,228,196,0.90) 78%,
  rgba(140,214,172,0.97) 100%);
box-shadow: inset 0 1.5px 0 rgba(255,255,255,0.9),
            0 18px 42px rgba(46,125,82,0.16),
            0 4px 12px rgba(0,0,0,0.07);
```

### Traffic light urgency dots (locked July 20)

Three fixed positions, top-left corner of every card. **One dot active at a time.** Position is the signal. Colour confirms it.

```
LEFT   = Overdue   = Red    #c0392b
MIDDLE = Today     = Amber  #b87a18  
RIGHT  = Upcoming  = Green  #2e7d52
ALL GREY = Nothing pending
```

```css
.traffic-light {
  position: absolute;
  top: 10px;
  left: 11px;
  display: flex;
  gap: 5px;
  z-index: 5;
}
.tl-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: rgba(80,60,20,0.13);
}
.tl-dot.overdue { background: #c0392b; box-shadow: 0 0 6px rgba(192,57,43,0.6); }
.tl-dot.today   { background: #b87a18; box-shadow: 0 0 6px rgba(184,122,24,0.5); }
.tl-dot.upcoming{ background: #2e7d52; box-shadow: 0 0 6px rgba(46,125,82,0.5); }
```

Priority logic: overdue > today > upcoming > nothing. Only the highest applies.

Card name must have `padding-left: 34px` to clear the dots. Heat emoji sits top-right.

### Front face content (top to bottom)
1. **Traffic light dots** — top-left, always visible
2. **Heat emoji** — top-right, `font-size: 13px`, `letter-spacing: -1px`, `opacity: 0.8`
3. **Deal name** — `font-size: 15px`, `font-weight: 400`, `color: rgba(20,14,4,0.88)`, `padding-left: 34px`
4. **Seller line** — 5px coloured dot + seller name, `font-size: 10.5px`, `font-weight: 400`
5. **Facts line** — `font-size: 9.5px`, `font-weight: 300`, dot-separated, NO chips
6. **Spacer** — `flex: 1`
7. **Icon band** — four frosted glass circles, no container, float in colour zone

### Icon band — front face
No surrounding box. No separator line. Icons float directly in the deep colour zone at the card base.

```css
.icon-btn {
  width: 34px; height: 34px;
  border-radius: 50%;
  background: rgba(255,255,255,0.22);
  border: 1px solid rgba(255,255,255,0.38);
  color: rgba(255,255,255,0.62);
  font-size: 15px;
}
.icon-btn:hover {
  transform: translateY(-5px) scale(1.08);
  background: rgba(255,255,255,0.52);
  color: rgba(20,14,4,0.8);
}
.icon-btn.active {
  background: rgba(255,255,255,0.42);
  color: rgba(20,14,4,0.7);
  transform: translateY(-2px);
}
.icon-btn.active::after {
  content: '';
  position: absolute;
  bottom: -4px; left: 50%;
  transform: translateX(-50%);
  width: 3px; height: 3px;
  border-radius: 50%;
  background: rgba(255,255,255,0.75);
}
```

Four icons: `ti-info-circle` (Info), `ti-activity` (Activity), `ti-check` (Tasks), `ti-paperclip` (Documents)

### Expand button
Top-right corner. Invisible at rest (`opacity: 0`, `transform: scale(0.75)`). Appears on card hover. 26px circle, `background: rgba(255,255,255,0.3)`, `border: 1px solid rgba(255,255,255,0.55)`. Icon: `ti-arrows-maximize`.

### Back face — inverted gradient
Same card turned over. Colour pools at TOP on back, dissipates downward. Same corner radius, font, weight. **No black header. Colour carries through.**

**Lead card back:**
```css
background: linear-gradient(175deg,
  rgba(210,168,60,0.95)  0%,
  rgba(232,200,110,0.88) 18%,
  rgba(248,232,168,0.72) 38%,
  rgba(254,248,225,0.55) 58%,
  rgba(255,255,255,0.28) 80%,
  rgba(255,255,255,0.12) 100%);
```

**Active card back:**
```css
background: linear-gradient(175deg,
  rgba(60,180,120,0.95)  0%,
  rgba(100,210,160,0.88) 18%,
  rgba(168,238,205,0.72) 38%,
  rgba(225,252,238,0.55) 58%,
  rgba(255,255,255,0.28) 80%,
  rgba(255,255,255,0.12) 100%);
```

### Back face content (top to bottom)
1. **Header zone** — coloured (card's own colour), not black. Deal name weight 400. Facts line weight 300. Status indicators. Close button (frosted glass circle, top-right).
2. **Gradient divider** — `height: 1px`, fades in and out, no hard line
3. **Content body** — switchable panels: Info / Activity / Tasks / Documents
4. **Icon band** — same four icons, warm tones on light background, orange active state

### Flip animation
```css
.flip-inner {
  transform-style: preserve-3d;
  transition: transform 0.65s cubic-bezier(0.4, 0, 0.2, 1);
}
.flip-inner.flipped { transform: rotateY(180deg); }
.face { backface-visibility: hidden; }
.back-face { transform: rotateY(180deg); }
```

### What each card communicates without reading
1. Honey = Lead, Mint = Active
2. Left red dot = overdue
3. Middle amber dot = due today
4. Right green dot = upcoming
5. Flames = opportunity heat
6. Bottom dot = seller status (green/amber/grey)

### Reference file
`DO_CARD_REFERENCE_v1.html` — render this before building any card component

---

## 5. UI Design — The Board

### Board structure
Single canvas. `background: #f8f7f4`. No columns separating card types.

Two card types appear on one board:
- **Lead cards** (honey) — pre-instrument opportunities
- **Active cards** (mint) — post-instrument deals (LOI/SPA/FCO exchanged)

Dead/closed deals go to Archive only — not a live board lane.

### Board controls — three independent dimensions

**1. Sort order**
- Urgency (default) — overdue → today → upcoming → nothing pending. Within each band, most flames first.
- Heat — most flames first regardless of task state
- Type — Lead grouped, Active grouped
- Recent — most recently touched first

**2. Layout mode**
- Stack (default) — cards fan-stacked, working mode
- Spread — all cards face-up, scanning/10,000-foot view

**3. Filter**
- Lead / Active / Both (default: Both)

All three controls are independent and combinable.

**Default on open:** Urgency sort, Stack layout, Both filter. Most urgent card at top of stack with left red dot active.

### Fan stack mechanics
- Cards stacked with `PEEK = 28px` between them
- Card height: `112px` in stack mode
- Sorted by urgency — overdue at top, nothing pending at bottom
- Only top portion of each card visible in stack — traffic light dots always visible above the fold

### Card states on the board
1. **Rest** — in fan position
2. **Hover/peek** — lifts `34px`, blushes, cards above shift slightly
3. **Selected** — first click, pops `68px` proud, shows "click to open" hint
4. **Expanded/workspace** — second click, expands to centred workspace showing back face
5. **Spread/focus** — column header click, all cards laid face-up in portrait grid

### Auto-return
At any point, clicking away returns cards to their base position automatically. Nothing stays displaced unless actively being worked.

### Spread deck (column/type focus)
Clicking the sort-by-type control or a column header compresses other card types to slivers and spreads the focused type into a portrait grid. Cards maintain `aspect-ratio: 5/7`. Click again to return to stack view.

### Floating pill launcher
Fixed bottom-right of board. Elongated dark pill `#1c1a10`, orange accent border `rgba(196,92,0,0.22)`. Contains user avatar (initials → photo when uploaded), name, "My workspace" hint, chevron.

Click to expand pill horizontally revealing mode options: Today · Registry · Stats · New

Mode selection opens a **floating panel** (not edge-docked) that hovers over the board. Same dark thin header band, warm cream body, Plus Jakarta Sans. Board dims gently behind it.

### Reference file
`DO_traffic_light_v2.html` — traffic light dots in fan stack and spread view

---

## 6. UI Design — Other Screens

### Right sidebar (correction — not yet built correctly)
The current implementation is wrong — dark panel, wrong typography, wrong colours. 

Correct design:
- Permanent sidebar, slides in alongside board (board compresses, not obscured)
- Warm cream body matching card back face
- Thin dark header band at top only
- Plus Jakarta Sans throughout, same weight system as cards
- Mode tabs at top of sidebar: Today / Registry / Stats / New
- Pill launcher is the trigger — tap opens sidebar, tap again closes

**Status: needs redesign. First task of next design session.**

### Table view (management/density mode)
Three density options via topbar switcher:

**Compact** — single line rows, status dot only, no avatars. Maximum density. For managers scanning 50+ deals.

**Comfortable (default)** — avatar circle, name, 2–3 facts, status dot + word. Hover blushes row in card colour family. Click → card rises from row with flip animation. Row highlights while card open.

**Cards** — the solitaire board view.

Click-to-surface: clicking any table row produces the card from that row position. Back face opens directly. Close contracts card back into row. Object permanence throughout.

### Contact card
Front face: avatar circle up top (initials or photo), name, role. Blue-lavender gradient family. Same glass surface, same corner radius.

Back face: deal history, total value, last contact date. Same inverted gradient.

**Status: direction agreed, not yet fully designed.**

### Task card
Single fan column in task registry. Urgency sorted. Same card grammar. Front: task name/due/priority/linked deal. Back: progress notes, linked deal.

**Status: not yet designed.**

### Focus view (third tier)
Third tier above the workspace back face. Full screen or near-full. Conventional squircle — not card proportions. All four sections visible simultaneously without tabs. For 20,000-foot view of a single deal.

Transition: back face workspace expands further into focus. Close → contracts to workspace → flip → card in fan.

**Status: not yet designed.**

---

## 7. Roadmap

### v9.x — Snagging (current, winding down)
Stable build in active use. Bug fixes only. No architectural changes.

### v10 — Foundation (next)
**Non-negotiable order:**

1. **Git repository** — before any code. Main + develop branches. Staging Supabase project.
2. **Authentication** — Google Auth via Supabase. Login/logout. Session persistence. User profile (name, email, avatar).
3. **Multi-tenancy** — `organisation_id` on every table. Row Level Security on every table. Organisation creation. User invitation. Admin/Member roles.
4. **Data model** — Companies/Contacts/Intents architecture replacing current Buyers/Sellers/People registries.
5. **Solitaire board** — full card interaction grammar as specified in Section 4 and 5. This is the signature feature.
6. **Today's Deck** — right sidebar panel showing priority hand for the day.
7. **Card grammar in registries** — seller, buyer, contact registries using card flip behaviour.
8. **Mobile responsive** — single column, horizontal swipe between card types, touch gestures, PWA manifest.
9. **User preferences** — animation level setting (see below), view preferences, stored per user.

### v11 — Intelligence + Full Grammar
- Drag-to-match interaction (seller cards fan below open deal, drag to match)
- Calendar card overlays (tap date → cards for that day)
- Contact card front/back faces with deal history
- Configurable entity types (tenant_config table)
- Rules-based matching engine
- Rich text editor (TipTap/Quill) in Journal
- Gmail integration
- Reporting and table view enhancements
- Alert/reminder system (Web Notifications API)

### v12 — AI Layer
- Anthropic API natural language query (NL → PostgREST)
- Vector/AI matching engine
- Microsoft 365 integration

### Animation level system (roadmap item — v10 design, v11 build)
User-controlled animation preference. Three levels:

**Level 0 — Off:** Instant transitions. No motion. For accessibility or speed preference.

**Level 1 — Subtle (default):** Current design. Smooth hover blush. Gentle lift. Flip animation. Professional and refined.

**Level 2 — Expressive:** More physical. Cards slide into position on board load. Urgency sort causes visible re-stacking. Spread deck fans out one by one from a central point. Pill launcher options rise like cards being dealt.

**Level 3 — Full physical:** Solitaire deal animation on board load. Cards visibly re-stack when sort fires. Full theatrical version of the physical metaphor.

Admin sets organisation default. Each user can override for themselves. Stored in user profile. Architecture must accommodate all levels from v10 even if only Level 1 ships initially.

---

## 8. Workflow — How This Product Is Built

### The three-tool structure

**Claude (this conversation)** — thinking, architecture, design decisions. All significant decisions about what DealOrchestra is, how it looks, and how it behaves are made here. Claude has been involved since the beginning and holds the full context of why decisions were made.

**Kimi Web** — translation and build instruction. Reads the master spec. Produces precise instructions for Kimi VS Code. Does not make design decisions independently — implements what the spec says.

**Kimi VS Code** — execution. Receives instructions from Kimi Web. Writes the actual code. Commits to repo.

### Session protocol — mandatory at start and end of every Claude session

**Every session START — upload these two files:**
1. `DEALORCHESTRA_MASTER_SPEC.md` — current decisions
2. `SESSION_LOG.md` — Claude reads the last entry first

Claude will:
- Check whether the last session was committed (COMMITTED: YES/NO)
- If COMMITTED: NO — flag it and ask Ken to commit via Kimi before proceeding
- Confirm master spec version matches the log
- Only then proceed with session work

**Every session END — Claude will automatically:**
1. Write a new entry in SESSION_LOG.md with timestamp, decisions, files changed
2. Set COMMITTED: NO
3. Give the exact Kimi commit message to use
4. Remind Ken to change COMMITTED: NO → YES after Kimi pushes
5. Remind Ken to push SESSION_LOG.md as part of the commit

**After Kimi commits and pushes:**
1. Open SESSION_LOG.md
2. Change `COMMITTED: NO` to `COMMITTED: YES`
3. Save and push: `git add SESSION_LOG.md && git commit -m "Mark session [date] committed" && git push`

### The single source of truth
This document (`DEALORCHESTRA_MASTER_SPEC.md`) is the shared brain. It lives in the Git repo alongside the code.

- No decision is locked until it is recorded here
- When this document and any other source conflict, this document wins
- At the start of every Claude session, upload the current version of this file
- Before every Kimi Web session, provide the current version of this file plus relevant HTML reference files

### The decision flow
```
You + Claude → Decision made → Recorded in this document
                                        ↓
                              Kimi Web reads spec
                                        ↓
                         Kimi Web produces build instructions
                                        ↓
                            Kimi VS Code writes code
                                        ↓
                              Code committed to repo
                                        ↓
                         Repo contains code + this spec
```

### When Kimi has a better idea
Bring it to Claude. Evaluate it together. If it's better, update this document. Then give Kimi the updated spec. The decision always flows through this document.

### What Kimi should never do
- Make design decisions not covered by the spec
- Change card gradients, typography, or interaction behaviour without spec authority
- Create new document types or naming conventions

### Reference HTML files
These live in the repo and are the visual ground truth. Always give them to Kimi alongside the spec.

| File | Purpose |
|------|---------|
| `DO_CARD_REFERENCE_v1.html` | Canonical card design — all states, flip, icons |
| `DO_traffic_light_v2.html` | Traffic light dot system — fan stack and spread view |

---

## 9. Open Questions

| Question | Context | Priority |
|----------|---------|----------|
| Contacts data model consolidation | One unified table with type column vs separate registries? Was raised July 2026 — prior discussion on June 23 may have rejected unified approach. Check before designing table view. | High — blocks table UI design |
| Animation level UI component | Where does the toggle live? Settings menu? Topbar? Per-user preference screen? | Medium — needed for v10 design |
| Colour palette options | 6–7 curated combinations from neutral to bold. All must preserve semantic colour hierarchy. Obsidian-style system. | Medium — needed before shipping |
| Mobile pill launcher position | Bottom-right may conflict with thumb zone on mobile. Alternative position? | Low — v10 mobile design |

---

## 10. Rejected Approaches

These were considered and deliberately discarded. Do not revisit without explicit reason.

| Approach | Why rejected |
|----------|-------------|
| Three-column board (Leads/Potential/Active) | Potential collapsed into Lead. Two card types on one board is cleaner. Filter handles separation. |
| Elaborate dual-wash board canvas | Cards carry colour now. Canvas competed instead of supporting. |
| Black/dark header on card back face | Jarring discontinuity — looked like a different product. Colour carries through instead. |
| Left accent bar on cards | Card colour surface communicates state more effectively. Removed permanently. |
| Chips on facts lines | Chip overload. Plain dot-separated text is cleaner and more legible. |
| Multiple urgency dots active simultaneously | Required users to interpret combinations. One dot, fixed position builds muscle memory instead. |
| Edge-docked side panel from pill launcher | Obscured board. Floating panel over board is correct. |
| Radial buttons from pill launcher | Four separate circles felt disconnected. Unified expanding pill is correct (Neo browser model). |
| Text-based status indicators ("1 overdue") | Replaced by traffic light dot system. Position-based, no reading required. |
| Ticker tape notification | Rejected on aesthetic and usability grounds. |
| Private tasks | Out of scope. Documented decision. |
| Field-level audit/change history | Enterprise/compliance pattern, not appropriate for 1–30 person teams. Activity-level logging only. |

---

## Change Log

| Date | Version | Changes |
|------|---------|---------|
| 20 Jul 2026 | 1.0 | Initial master spec created. Consolidates: DEALORCHESTRA_DESIGN_DECISIONS_updated.md (Sections 1–19), ROADMAP_updated.md, DEALORCHESTRA_SESSION_HANDOVER_14JUL2026.md, DO_DESIGN_UPDATE_20JUL2026.md, workflow decisions. Adds: animation level system, two-tool workflow structure, consolidated open questions and rejected approaches. |
