# NBA Augmentation — Inventory & Valuation

A live web app that replaces the *NBA Augmentation Model & Inventory* Excel workbook with a
Supabase (Postgres) backend. It tracks game inventory, computes each matchup's tier/CPM
valuation from the same logic as the spreadsheet, and lets planners build priced packages.

## What it does
- **Inventory grid** — every augmentable game with its tier score, tier, CPM, impressions and
  cost. Change a game's status (Open / Pitched / Sold / Closed) or brand/contact inline; writes
  straight back to the database. Games flexed to national (local inventory lost) are flagged ⚑.
- **Package builder** — filter by team / date / status, tick games, and see live totals: blended
  CPM, total impressions vs target, average cost per game, total cost, and flight window. Save it.
- **Valuation engine** — `tier_score = timezone_score + (aug + opponent YouGov popularity) +
  aug impression_rank`, bucketed into Tiers 1–4 → CPM (45 / 40 / 30 / 25). Verified to match the
  Excel (e.g. Warriors @ Clippers = 105 → Tier 2 → $40).

## Run it (demo mode — no backend needed)
```bash
npm install
npm run dev
```
With no `.env.local`, the app runs off the bundled seed (`src/seed.json`) — 30 teams, 533 games —
so you can click around immediately. A **DEMO** badge shows in the header.

## Go live on Supabase
1. Create a project at supabase.com.
2. In the SQL editor, run, in order:
   - `../supabase/migrations/0001_schema.sql`  (tables + valuation views)
   - `../supabase/migrations/0002_policies.sql` (prototype RLS)
   - `../supabase/migrations/0003_projection.sql`  (2027 projection views + conference)
   - `../supabase/migrations/0004_projection_default.sql` (default to upcoming 2027)
   - `../supabase/seed.sql`                      (teams, schedule, inventory)
3. Copy `.env.example` → `.env.local` and paste your Project URL + anon key.
4. `npm run dev`. The badge flips to **LIVE · Supabase** and all reads/writes hit Postgres.

> The schema keeps the valuation logic in SQL views (`game_valuation`, `package_summary`), so the
> numbers are identical whether computed in the browser (demo) or the database (live).

## Inventory MCP (for AI agents)
Deploy `supabase/functions/inventory-mcp` as an Edge Function. It exposes tools to list inventory,
summarize availability, and **estimate packages by budget** (e.g. a $500k RFP).

**Default season is upcoming 2027** (all games Open). No setup needed for package-building questions.

For **last season (2026)** historical questions — sold counts, what was pitched, etc. — pass
`season: "2026"` (or `"last"`) on any inventory tool, plus status filters as needed.

Example upcoming-season RFP (defaults to 2027):
```
estimate_package {
  aug_conference: "Western",
  aug_timezone: "Pacific",
  budget: 500000
}
```

Example last-season sold count:
```
inventory_summary {
  season: "2026",
  status: ["Sold"],
  team: "Warriors"
}
```

## Notes / next steps
- RLS is permissive for the prototype (anon can read + write). Tighten to authenticated roles
  before real use.
- The schedule is currently seeded from the workbook. The natural next step is an automated
  refresh (scrape/API) writing into `games` so the grid stays current without manual updates —
  which was the core ask from the discovery call.
- `scripts/parity-check.mjs` re-verifies the valuation against the Excel reference case.
