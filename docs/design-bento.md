# JusttPrint 10 design: Bento

The look for JusttPrint 10, the release that brings FilamentHub's filament tracking into JusttPrint (plan: [merge-10.md](merge-10.md)). Source of truth: the "J2" screens on the design canvas (J2 · Bento, J2 · Library (browse style), J2 · Model page, J2 · Filament), copied into [design/](design/). This file turns them into tokens and components for `src/web/`.

## Decisions

- **Two layouts, one look.** Dashboards (Home, Filament, Printers) are **bento grids**: tiles of different sizes, each answering one question. The library is a **browse layout**: big search, category tabs, banners, sort tabs and a dense grid of picture-first cards; a click opens the model page.
- **Light first.** Slate and coral on a light slate ground. A dark theme stays possible: every color is a token, as since 5.0. The current accent themes (Settings → Theme) are replaced by coral; a dark variant is a later feature.
- **Plus Jakarta Sans** (OFL) replaces Inter, bundled with `@fontsource-variable/plus-jakarta-sans` like Inter is today, so the app still works offline and under the Content Security Policy.
- **Lucide icons stay.**
- **Filament is everywhere it matters.** Every model card and model page says whether you can print it with what you own; spools show how full they are as rings.
- **Real data only** (as in 5.0). Nothing on screen is invented; where the data is not there yet, the tile is left out.

## Tokens

The `--jp-*` names stay; their light values change. New tokens are marked *new*.

| Token | Value | Use |
|---|---|---|
| `--jp-bg` | `#eef1f5` | Page ground (light slate) |
| `--jp-surface-1` | `#ffffff` | Cards and white tiles |
| `--jp-surface-2` | `#f4f6f9` | Rows inside cards, input wells |
| `--jp-surface-hover` | `#e2e7ee` | Hover, quiet tiles ("Other printers", "Add a spool") |
| `--jp-border` | `#dde2ea` | Hairlines, inactive chip borders |
| `--jp-border-strong` | `#cfd6e0` | Secondary button borders |
| `--jp-text` | `#1e2633` | Text, dark tiles' ground |
| `--jp-text-2` | `#3c4a60` | Secondary text on white |
| `--jp-text-3` | `#5b6576` | Meta text (4.5:1 on `--jp-bg`) |
| `--jp-ink-tile` *new* | `#1e2633` | Dark feature tiles |
| `--jp-ink-tile-2` *new* | `#2b3647` | Chips and tracks on dark tiles |
| `--jp-on-ink` *new* | `#ffffff` / `#c8d0dc` | Text / meta on dark tiles |
| `--jp-accent` | `#e8604c` | Coral: main actions, "needs you" tiles, progress, active underline |
| `--jp-accent-soft` | `#fde6e1` | Short-on-filament rows, warning cards |
| `--jp-accent-text` *new* | `#c2412d` | Coral used as text or links on white |
| `--jp-accent-strong-text` *new* | `#9a3020` | Text on `--jp-accent-soft` |
| `--jp-accent-tint` *new* | `#f2a596` | Coral on dark tiles; secondary bars |
| `--jp-on-accent` | `#1e2633` | Text on coral (slate, not white: 4.9:1) |
| `--jp-success` / `-soft` / text | `#2f9e44` / `#e3f3ea` / `#1f6b43` | "Ready to print", printed, OK |
| `--jp-warning` / `-soft` | `#e8a33c` / `#fff3dc` | Maintenance due |
| `--jp-info-soft` *new* | `#e8edf5` (text `#2c55b8`) | "Printing" status |
| `--jp-radius-tile` *new* | `28px` | Bento tiles |
| `--jp-radius-xl` | `24px` (was 16) | Cards, panels |
| `--jp-radius-lg` | `14px` (was 12) | Buttons, inputs, rows |
| `--jp-radius-pill` | `999px` | Chips, pills, nav |
| `--jp-shadow-card` *new* | `0 1px 2px rgba(30,38,51,.06), 0 8px 24px rgba(30,38,51,.05)` | White cards and tiles |
| `--jp-font` | `'Plus Jakarta Sans Variable', system-ui, sans-serif` | All text |

Type: page titles 40px/800, tile numbers 44–64px/800, card titles 15–18px/800, tile headings 13px/800 uppercase with 0.08em tracking, body 14–15px/500–600. `styles/contrast.test.ts` gets the new pairs (coral on white as text uses `--jp-accent-text`; slate on coral; meta text on `--jp-bg`).

## Components

Existing components in `src/web/components/` are restyled through the tokens; these are new (all shown at `#/design-system`):

| Component | What it is | Seen on |
|---|---|---|
| `BentoGrid`, `Tile` | 4-column grid (`grid-auto-rows: minmax(210px, auto)`, 20px gap; one column under 900px). `Tile` variants: `white`, `ink` (dark), `accent` (coral), `quiet`. Props for column and row span. | Home, Filament, Library (bento) |
| `SpoolRing` | Conic ring filled to the spool's remaining share, its color in the middle; coral ring under 50 g, light coral under 300 g. Sizes 28–84px. | Everywhere spools appear |
| `ColorDot` | Filament color dot; coral ring when that color is short. | Cards, model page, queue |
| `IsoThumb` | Placeholder art when a model has no picture: an isometric block in the model's first filament color (three shades), optionally a second block. Real thumbnails always win. | Cards, banners |
| `FitBadge` | "Ready to print" (success) or "Need black" (accent soft) from the filament check. | Cards, lists |
| `BrowseCard` | Picture (4:3) with source pill, heart, FitBadge and plate count; title, designer avatar and name, color dots; stats row (times printed, grams, print time). The whole card is a link. | Library browse |
| `CategoryTabs` | Horizontal scroller of category buttons with an `IsoThumb` icon each; subcategory chips below. Uses the existing 11 categories. | Library browse |
| `SortTabs` | Text tabs with a coral underline. | Library browse, model page |
| `Toggle` | Switch ("Fits my filament"). | Library browse |
| `ProfilePicker` | Print profile buttons (All plates / Plate N · name, with time and grams); the selected one is ink. | Model page |
| `FilamentCheck` | One row per needed color: dot, color and grams, matched spool and slot, result ("✓ 558 g left" or "12 g short"). | Model page, queue, Up next |
| `Gallery` | Big picture with a thumbnail strip (selected thumbnail ringed in coral). | Model page |

## Screens

| Screen | Route | Canvas board | Notes |
|---|---|---|---|
| Home | `#/home` | J2 · Bento | Ink tile "Printing now" (ring, AMS chips), coral "Needs you", Spools, Up next, New in your library, This month, Other printers |
| Library | `#/library` | J2 · Library (browse style) | Replaces today's library header and card. Folder tree, Wall and List views stay available from a view menu. |
| Model page | `#/model/<id>` | J2 · Model page | Today's `ModelPage` restyled; the details column keeps its role for quick edits. |
| Filament | `#/filament` | J2 · Filament | New page (spools); the catalog becomes "Add from catalogue". |
| Printers | `#/printers` | not drawn yet | Bento tiles per printer with AMS slots |
| Queue, Settings, phone layout | | not drawn yet | |

Breakpoints stay as in 5.0 (1200 / 1023 / 700px). On phones the bottom bar holds Home, Library, Filament, Printers and Menu.
