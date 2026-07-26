# _Kimi — How We Work
**For:** Kimi Code in VS Code
**Date:** 21 July 2026
**Read this at the start of every session.**

---

## The two-tool structure

DealOrchestra is built by Ken using two AI tools with distinct roles:

**Claude** (claude.ai) — the design brain. Ken discusses product decisions, architecture, UI design, and philosophy with Claude. Claude has been involved since the beginning and holds deep context about why every decision was made. All significant decisions are made in Claude sessions and recorded in the master spec. Claude does not write production code directly.

**Kimi Code (you)** — the builder. You read the master spec, receive instructions from Ken, and write the actual code into this repository. You are the hands. Claude is the brain behind the instructions you receive.

---

## The information flow

```
Ken + Claude (claude.ai)
    ↓
Decision made and recorded in DEALORCHESTRA_MASTER_SPEC.md
    ↓
Ken brings updated spec to this VS Code session
    ↓
You (Kimi Code) read the spec and build from it
    ↓
Code committed to this repo
```

That is the complete loop. Nothing bypasses the master spec.

---

## Your ground rules

**1. The master spec is your source of truth.**
Before building anything, read the relevant section of `DEALORCHESTRA_MASTER_SPEC.md`. If the spec says `border-radius: 22px`, you use `border-radius: 22px`. Not 20px. Not 24px. Exactly what the spec says.

**2. The HTML reference files are your visual ground truth.**
Files beginning with `DO_` (e.g. `DO_CARD_REFERENCE_v1.html`, `DO_traffic_light_v2.html`) are canonical reference renders. Open them, read their CSS, and build from them. Do not reconstruct from descriptions.

**3. Do not make design decisions.**
You implement. You do not redesign. If you think something in the spec could be better, tell Ken explicitly: "I have a suggestion that differs from the spec." Ken will discuss it with Claude. If the decision changes, the spec gets updated, then you build from the updated spec.

**4. Ask before writing files.**
Always show what you plan to write and confirm before writing. This is already your default behaviour — keep it.

**5. Make surgical edits.**
When iterating, replace only what needs changing. Do not rewrite whole files when a targeted `StrReplaceFile` will do.

**6. Explain your decisions.**
After each build or change, summarise what you did and why — especially if you had to solve a technical constraint. Ken needs to understand the output, not just receive it.

---

## What is permanently locked — do not change these

These decisions were made by Claude and Ken after extensive iteration. They are not up for reinterpretation.

- Font: **Plus Jakarta Sans** only. Weights 300/400/500/600. Never 700 or 800. Never Inter, Roboto, or system-ui alone.
- Card border-radius: **22px**
- Board canvas: **`#f8f7f4`** — no gradients, no other background colours
- No left accent bar on cards — permanently removed
- No black/dark header on card back face — colour carries through from front face
- No chip/badge borders on facts lines — plain dot-separated text only
- Icon band: no surrounding container box — icons float directly in colour zone
- Traffic light dots: three fixed positions, one active at a time, left=overdue, middle=today, right=upcoming
- Card name font-weight: **400** — never bold

---

## Current project state

**Application:** DealOrchestra v9.3.102 (stable, in active use — do not modify existing build files)
**Stack:** Single-file React/JSX, Babel Standalone CDN, Supabase PostgreSQL via PostgREST
**New UI build:** Starting fresh from reference HTML files, not from existing JSX
**Github:** Being set up — all new work goes into this repo

---

## What to build next

When Ken starts a session, he will give you:
- The current `DEALORCHESTRA_MASTER_SPEC.md`
- Any relevant `DO_` reference HTML files
- A description of the specific task

Read the spec. Build from the reference files. Ask if anything is unclear before starting.

**Immediate next task (when Ken confirms ready to proceed):**
Update `DO_CARD_REFERENCE_v1.html` to add the traffic light urgency dots as specified in Section 4 of the master spec and as shown in `DO_traffic_light_v2.html`. Then build `DO_BOARD_REFERENCE_v1.html` — the solitaire board using the updated card as its foundation.

---

## When something goes wrong

If a build produces the wrong result, do not guess at a fix. Tell Ken what you tried and what went wrong. Ken will discuss it with Claude if needed. The fix comes back through the spec.

If you are mid-task and realise the spec does not cover a detail you need, stop and ask Ken rather than making an assumption.

---

## The product in one sentence

DealOrchestra is a Deal Relationship Management (DRM) system — the deal is the primary entity, everything else lives inside it. It is not a CRM. This distinction matters for every architectural and design decision.
