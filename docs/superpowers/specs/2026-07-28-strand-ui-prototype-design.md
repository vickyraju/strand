# Strand — UI/UX-First Prototype Design

## Context

Strand is the planned internal replacement for Meridian Capital's Jira Data Center deployment (see `Strand_PRD_v1.docx` — 50k users, single-tenant AWS/EKS deployment, "familiar bones, modern body" design thesis: Jira's IA and vocabulary preserved, interaction layer rebuilt Linear-style).

The repo started empty (greenfield). Rather than starting with backend/infra — which the PRD itself gates behind a Discovery/Architecture phase and six validation spikes — the decision was to build the **real UI/UX first**: a coded, clickable prototype against mock data, so the direction can be agreed on before any backend work starts. This becomes the visual/UX reference the eventual real build implements against.

Decisions:
- **Fidelity**: coded prototype (Next.js/React), not static mockups — it evolves into the real frontend later rather than being thrown away.
- **Scope (this pass)**: core work management only — board, backlog/sprint, work item detail, search. Admin, AI Assist, dashboards, notifications, and marketplace are explicitly deferred.
- **Visual direction**: "Structured Neutral" — slate/zinc neutral base + indigo accent, Inter typeface, compact/dense spacing, near-flat shadows, light + dark both first-class. Chosen over a softer "Enterprise Blue" alternative because it reads as "built for power users" (Linear/Notion feel) rather than a generic SaaS marketing dashboard — matching the PRD's explicit "speed of Linear" / "simplicity of Notion" positioning.

Design intelligence pulled from the `ui-ux-pro-max` skill (design-system search, style/color/typography domains) and the `frontend-design` skill informed the choices below.

## Design System

**Tokens** (primitive → semantic, as CSS variables in `app/globals.css`, consumed via `tailwind.config.ts`):

| Token | Light | Dark |
|---|---|---|
| `--background` | `#F8FAFC` | `#0B0F17` |
| `--foreground` | `#0F172A` | `#E2E8F0` |
| `--primary` | `#4F46E5` (indigo-600) | `#6366F1` (indigo-500) |
| `--muted` | `#F1F5F9` | `#111827` |
| `--border` | `#E2E8F0` | `#1E293B` |
| `--destructive` | `#DC2626` | `#EF4444` |
| `--ring` | `#4F46E5` | `#6366F1` |

- **Typography**: Inter (via `next/font/google`), weights 400/500/600. `font-variant-numeric: tabular-nums` on all counts, IDs, and story-point figures so columns don't jitter.
- **Radius**: 6px cards/buttons, 4px inputs. **Shadow**: near-flat; one subtle elevation level reserved for popovers/modals/command palette only.
- **Density**: compact — 32–36px row height, 8px spacing grid (dashboard-density, not marketing-density).
- **Icons**: `lucide-react` (matches shadcn default), no emoji.
- **Signature element**: the work-item key badge (e.g. `ENG-4821`) — tabular-mono-weight, consistently styled everywhere it appears (board card, backlog row, item header, search results). It's Strand's visual anchor to Jira's key-based mental model while looking crisp and modern.
- **Voice**: plain, active-voice copy ("Save," not "Submit"; "Blocked," not a jargon status code) — mirrors the PRD's own repeated "plain-language" requirement (§2.2, FR-WF02, FR-AD01), so the UI's tone and the product's stated philosophy reinforce each other.
- Light and dark mode are built together from the start (via `next-themes`), not retrofitted.

## Stack

- **Next.js (App Router) + TypeScript + Tailwind CSS + shadcn/ui** (Radix-based primitives — accessible by default, matches the PRD's own React+TypeScript frontend choice in §5.3).
- `cmdk`-based `Command` component (ships with shadcn) for the ⌘K command palette — serves FR-S01–S03 (clickable filter tokens, JQL-style input, plain-English toggle) as a visual/UX shell now, real query parsing later.
- No backend, no database. All data comes from static TypeScript fixtures under `lib/mock-data/`, modeling one Meridian-like org with 2 sample projects (`ENG`, `PLAT`), ~50–60 work items, a couple of active sprints, sample users/comments.
- Package manager: npm.

## Screens (this pass)

1. **App shell** — collapsible left sidebar (project switcher, nav), top bar (search/⌘K trigger, theme toggle, user menu).
2. **Board** (`/[project]/board`) — columns by workflow status, WIP limits with at-limit indicator, epic swimlane toggle, compact density toggle, client-side drag-and-drop (visual/optimistic only, no persistence).
3. **Backlog + Sprint** (`/[project]/backlog`) — keyboard quick-create, drag re-rank, multi-select bulk action bar, sprint panel showing committed points vs. velocity (warn, never block, per FR-B04).
4. **Work item detail** (`/[project]/item/[key]`) — inline-editable title/description/sidebar fields, first-class sub-tasks with aggregate progress, typed links (Blocks/Relates to/Blocked by), comment thread with @mentions and rich text.
5. **Global command palette** (⌘K, overlay) — clickable filter-token search bar (FR-S01) with a JQL-style input mode (FR-S02/S03), visual only.

Explicitly **not** built this pass: notifications, dashboards/reporting, admin (access/workflow editor), AI Assist surfaces, marketplace.

## File Structure

```
app/
  layout.tsx          # fonts, ThemeProvider, shell
  globals.css          # design tokens
  page.tsx             # redirect → default project board
  [project]/
    board/page.tsx
    backlog/page.tsx
    item/[key]/page.tsx
components/
  shell/               # Sidebar, Topbar, CommandPalette
  board/                # BoardColumn, BoardCard, WipIndicator
  backlog/              # BacklogRow, SprintPanel, BulkActionBar
  item/                 # ItemHeader, InlineEditableField, SubtaskList, LinkedItems, CommentThread
  ui/                   # shadcn-generated primitives
lib/
  mock-data/            # projects.ts, issues.ts, sprints.ts, users.ts, comments.ts
  types.ts              # WorkItem, Project, Sprint, Board, Comment, User
```

## Verification

- `npm run build` type-checks and builds cleanly.
- `npm run dev`, walk all 5 screens in a real browser: board drag interaction, backlog quick-create and bulk actions, item detail inline editing, ⌘K palette open/search, light↔dark toggle.
- Keyboard-only pass: tab order, visible focus rings, ⌘K reachable and operable without a mouse.
- Responsive check at 375px / 768px / 1024px / 1440px, no horizontal scroll.
- No console errors/warnings on any of the 5 screens.
