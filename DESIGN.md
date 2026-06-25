# Design

Visual system for **Group Radar** — a customer-finding + price-intelligence workspace
for Vietnamese resellers (extension popup + management dashboard + read-only web dashboard).

This is a full redesign away from the earlier "dark + indigo card-grid" look (the
default AI dev-tool reflex). The committed direction is a **near-monochrome market
terminal**: a calm graphite workspace, deliberately *not* colourful, where every number
reads with the precision of a trading screen and colour appears only when it carries
meaning.

## Theme

Dark, single theme. The user scans posts, prices, and conversations for long stretches,
often at night, juggling many groups and tabs. A graphite surface keeps the chrome quiet
so the *content* — post text, price rows, deal spreads — carries the color. Dark here is
a working decision (long sessions, dense data, money-signal accent pops on near-black),
not a stylistic default.

## Color

OKLCH throughout. Strategy: **Restrained, near-monochrome** — true-neutral graphite
surfaces (chroma ~0, NOT blue-tinted) carry almost the entire UI. There is no vivid
accent: a single **quiet warm-sand** tone (very low chroma, ~0.045) marks primary action,
active nav, and focus. Cheap-vs-expensive is the only place saturated-ish hue is allowed,
and even there green/red are **muted** so the screen never reads as colourful. The guiding
rule is *không màu mè* — colour must earn its place by carrying meaning.

### Core ramp (true graphite, chroma 0)

| Token | OKLCH | Role |
|---|---|---|
| `--bg` | `oklch(0.155 0 0)` | App background (deepest) |
| `--surface` | `oklch(0.190 0 0)` | Cards, panels |
| `--surface-2` | `oklch(0.225 0 0)` | Insets, nested rows, hover |
| `--surface-3` | `oklch(0.262 0 0)` | Raised / active inset |
| `--sb` | `oklch(0.125 0 0)` | Sidebar (darker than bg) |
| `--sb-2` | `oklch(0.205 0 0)` | Sidebar hover/raised |
| `--line` | `oklch(0.300 0 0)` | Borders (hairline) |
| `--line-soft` | `oklch(0.255 0 0)` | Subtle dividers |
| `--ink` | `oklch(0.960 0 0)` | Primary text (≥13:1 on bg) |
| `--ink-soft` | `oklch(0.765 0 0)` | Secondary text (≥4.5:1) |
| `--ink-faint` | `oklch(0.600 0 0)` | Tertiary/labels (≥4.5:1 large) |

### Accent (quiet warm sand — primary action, used sparingly)

Deliberately low-chroma. This is not a "money-gold" highlight; it is a restrained warm
neutral that reads as *slightly* warmer than the graphite around it. Used only for primary
buttons, the active nav item, and focus — never as decoration.

| Token | OKLCH | Role |
|---|---|---|
| `--accent` | `oklch(0.745 0.045 80)` | Primary actions, active nav, focus |
| `--accent-bright` | `oklch(0.80 0.05 82)` | Hover (a touch lighter) |
| `--accent-soft` | `oklch(0.285 0.014 80)` | Faint tinted fill for chips/badges |
| `--accent-ink` | `oklch(0.80 0.04 82)` | Faint warm text on dark |
| `--accent-ring` | `oklch(0.745 0.045 80 / 0.40)` | Focus ring |
| `--on-accent` | `oklch(0.20 0.012 80)` | Near-black ink on the solid accent |

Note: the accent is a *light* tone, so solid accent buttons take **dark** ink
(`--on-accent`), never white.

### Semantic (muted — functional only)

Reserved strictly for meaning, and intentionally desaturated so they read as quiet
indicators rather than colour:
green `oklch(0.72 0.085 150)` (cheaper / success), red `oklch(0.64 0.115 25)` (pricier /
over budget / danger), blue `oklch(0.70 0.045 240)` (info / watching),
amber `oklch(0.76 0.065 80)` (warning). Each pairs with a `*-soft` dark tint (L≈0.28) for
badge fills. Never gray text on a colored tint.

### Avatars

List avatars (groups, posts, products, advisory, conversations, store, prices) use
`colorFor()` → `hsl(h, 10%, 36%)`: a faint per-name hue at very low saturation, dark
enough that white initials stay legible. Quiet graphite chips, **not** a rainbow — this
was the single biggest source of on-screen colour and is now neutralised.

## Typography

Three deliberate roles on a contrast axis (not two similar sans):

- **Space Grotesk** (700) — brand wordmark, page title, panel headings, stat numbers.
  A characterful grotesk that signals "designed", not the system-font default.
- **System UI sans** (`-apple-system, "Segoe UI", Roboto…`) — all body, labels, buttons,
  form controls. Familiar and dense; the tool disappears into the task.
- **JetBrains Mono** (500/600) — every price, spread, count, and ID. Tabular figures line
  up vertically in price lists and comparison tables; the monospace read is the "terminal"
  precision cue and the core signature of this redesign.

Fixed rem-ish px scale (product, not fluid): 11px micro-labels, 12px meta, 13px body,
14px controls, 15px panel titles, 19px page title, 15px brand, 27px stat numbers.
Heading letter-spacing -0.01em (Space Grotesk is already tight). Mono numbers -0.01em.

## Spacing

Base-4: 4, 6, 8, 10, 12, 14, 16, 20, 24, 28. Section padding 24–28px, panel padding 16px,
control gaps 8–12px. Vary for rhythm — overview breathes, tables/price-lists run dense.

## Radius

Tighter than the old system (the old 12/16px on every card was part of the soft look).
`--r-sm` 6px (controls, chips), `--r-md` 10px (cards, inputs, panels). Pills 999px for
badges/toggles only. No card radius above 10px.

## Elevation

Flat-first. Raised state reads through **border + background shift**, not puffy drop
shadows and not translateY hover-lifts (both were old tells). A single hairline border is
the default; hover brightens the border and surface. `--shadow-pop` (defined, low-blur) is
reserved for genuinely floating layers only: toasts, modals, dropdowns.

## Z-index scale

dropdown 100 → sticky 200 → modal-backdrop 800 → modal 900 → toast 1000. No arbitrary 9999.

## Motion

Product-speed 120–200ms, conveys state not decoration. Ease-out
(`cubic-bezier(0.22, 1, 0.36, 1)`). No bounce/elastic, no translateY lifts. View crossfade
on tab switch stays subtle. Indeterminate crawl bar + build spinner are the only loops.
Every transition has a `prefers-reduced-motion: reduce` path (instant/crossfade).

## Layout & IA

- App shell: fixed left sidebar (graphite, darker than content) + sticky topbar + scrolling
  work area. Responsive: sidebar collapses on narrow widths.
- **Sidebar is grouped, not a flat 14-item list** (the old flat list was a navigation smell
  for this many destinations). Labeled sections by job-to-be-done:
  - **Khám phá** — Tổng quan, Nhóm, Bài viết
  - **Tự động hoá** — Đăng bài, Bình luận, Hội thoại, Tư vấn AI, Build AI
  - **Giá & Kho** — Giá Group, Sản phẩm/Giá, Kho của tôi, Nguồn dữ liệu
  - **Hệ thống** — Từ khoá học, Chia sẻ, Cài đặt
- Topbar carries page title + contextual subtitle + global actions.

## Components (all states required)

Buttons (primary/ghost/danger-ghost/sm/block), inputs/select/textarea, search box, panels +
panel-head, stat cards, group/post/advisory/conversation/group-price cards, jobs, pills
(pending/running/done/error), segmented toggles, switches (full + mini), chips, tables,
toasts, modals, empty states. Each interactive element ships default + hover + focus-visible
+ active + disabled; async surfaces add loading + error.

**Class contract is frozen.** The 15 JS view modules render fixed class names
(`.gp-card`, `.cmp-row`, `.adv-card`, `.build-item`, `.pill`, `.lead-badge`, …). The
redesign re-skins every one of these names; it does not rename them.

## Accessibility

WCAG AA. Body text ≥4.5:1, large/secondary ≥3:1, placeholders ≥4.5:1. Visible focus ring
(`--accent-ring`, never removed). Solid-amber controls use dark ink for contrast. Vietnamese
UI copy preserved verbatim. `prefers-reduced-motion` honored.
