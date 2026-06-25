// NBA Augmentation — Inventory MCP Server
// Streamable-HTTP MCP server exposing read-only inventory + package-estimate tools
// over the Genius Sports NBA augmentation Supabase database.
//
// Transport: MCP Streamable HTTP (single endpoint, JSON responses).
// Auth: none (prototype). Deploy with verify_jwt = false.

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
// Service role bypasses RLS for read queries inside the trusted function.
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
});

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "nba-augmentation-inventory", version: "1.0.0" };

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, authorization, mcp-session-id, mcp-protocol-version",
  "Access-Control-Expose-Headers": "mcp-session-id",
};

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

const STATUSES = ["Open", "Pitched", "Sold", "Closed", "N/A"];

function normalizeTiers(tiers?: string[]): string[] | undefined {
  if (!tiers || tiers.length === 0) return undefined;
  return tiers.map((t) => {
    const s = String(t).trim();
    if (/^[1-4]$/.test(s)) return `Tier ${s}`;
    if (/^tier\s*[1-4]$/i.test(s)) return `Tier ${s.replace(/\D/g, "")}`;
    return s;
  });
}

const GAME_FIELDS =
  "id,game_date,game_time_et,day_of_week,home_team,away_team,aug_team,opp_team,home_rsn,away_rsn,status,brand_contact,national_exclusive,tier,cpm,tier_score,impressions,game_cost,aug_conference,aug_timezone,aug_dma_market";

let projectionCache: { at: number; enabled: boolean } | null = null;
const PROJECTION_TTL_MS = 5000;

async function isProjectionEnabled(): Promise<boolean> {
  const now = Date.now();
  if (projectionCache && now - projectionCache.at < PROJECTION_TTL_MS) {
    return projectionCache.enabled;
  }
  const { data, error } = await sb
    .from("settings")
    .select("value")
    .eq("key", "projection_2027_enabled")
    .maybeSingle();
  if (error) throw new Error(error.message);
  // Default to upcoming 2027 projection when unset.
  const enabled = data == null ? true : Number(data.value) === 1;
  projectionCache = { at: now, enabled };
  return enabled;
}

function seasonLabel(projection: boolean): string {
  return projection ? "2027" : "2026";
}

function isHistoricalStatusQuery(status?: string[]): boolean {
  if (!status?.length) return false;
  const historical = new Set(["Sold", "Pitched", "Closed", "N/A"]);
  return status.every((s) => historical.has(s));
}

const LAST_SEASON_ALIASES = new Set([
  "2026", "last", "previous", "prior",
  "last year", "last season", "previous season", "prior season",
]);

async function resolveSeason(
  args: Record<string, unknown>,
): Promise<{ projection: boolean; season: string; season_auto_inferred: boolean }> {
  const seasonArg = args.season != null ? String(args.season).trim().toLowerCase() : null;
  if (seasonArg) {
    if (["2027", "upcoming", "next", "projection"].includes(seasonArg)) {
      return { projection: true, season: "2027", season_auto_inferred: false };
    }
    if (LAST_SEASON_ALIASES.has(seasonArg)) {
      return { projection: false, season: "2026", season_auto_inferred: false };
    }
    throw new Error(
      `Unknown season '${args.season}'. Use '2027' (upcoming, default) or '2026' / 'last' (last season).`,
    );
  }
  if (typeof args.use_projection === "boolean") {
    return {
      projection: args.use_projection,
      season: seasonLabel(args.use_projection),
      season_auto_inferred: false,
    };
  }
  // Sold/Pitched/Closed on the 2027 projection is always empty — use last season automatically.
  if (isHistoricalStatusQuery(args.status as string[] | undefined)) {
    return { projection: false, season: "2026", season_auto_inferred: true };
  }
  const enabled = await isProjectionEnabled();
  return { projection: enabled, season: seasonLabel(enabled), season_auto_inferred: false };
}

function applyFilters(q: any, a: Record<string, unknown>) {
  const status = a.status as string[] | undefined;
  if (status && status.length) q = q.in("status", status);

  const tiers = normalizeTiers(a.tier as string[] | undefined);
  if (tiers && tiers.length) q = q.in("tier", tiers);

  if (a.team) {
    const t = String(a.team).replace(/[%,]/g, " ");
    q = q.or(`home_team.ilike.%${t}%,away_team.ilike.%${t}%,aug_team.ilike.%${t}%`);
  }
  if (a.aug_conference) q = q.eq("aug_conference", a.aug_conference);
  if (a.aug_timezone) q = q.eq("aug_timezone", a.aug_timezone);
  if (a.date_from) q = q.gte("game_date", a.date_from);
  if (a.date_to) q = q.lte("game_date", a.date_to);
  if (a.day_of_week) q = q.eq("day_of_week", a.day_of_week);
  if (typeof a.national_exclusive === "boolean") {
    q = q.eq("national_exclusive", a.national_exclusive);
  }
  return q;
}

function selectByBudget(games: any[], budget: number) {
  const sorted = [...games].sort(
    (a, b) => Number(b.impressions ?? 0) - Number(a.impressions ?? 0),
  );
  const selected: any[] = [];
  let cost = 0;
  for (const g of sorted) {
    const gameCost = Number(g.game_cost ?? 0);
    if (cost + gameCost <= budget) {
      selected.push(g);
      cost += gameCost;
    }
  }
  selected.sort((a, b) => String(a.game_date).localeCompare(String(b.game_date)));
  return selected;
}

function fmtUSD(n: number): string {
  return "$" + Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 });
}

// ----------------------------------------------------------------------------
// Tool definitions
// ----------------------------------------------------------------------------

const FILTER_PROPS = {
  season: {
    type: "string",
    enum: ["2027", "2026", "upcoming", "last", "last season", "last year"],
    description:
      "REQUIRED for historical questions. Default (omit): upcoming 2027 — all Open. " +
      "For 'how many did we sell last year/season', 'what was pitched', etc. ALWAYS pass season='2026' or season='last'. " +
      "The 2027 projection has no Sold/Pitched/Closed data.",
  },
  use_projection: {
    type: "boolean",
    description:
      "Legacy override: true = 2027 projection, false = last season (2026). Prefer the season parameter.",
  },
  status: {
    type: "array",
    items: { type: "string", enum: STATUSES },
    description:
      "Inventory statuses to include. Open = available, Pitched = offered to a brand, Sold = booked, Closed/N/A = unavailable. Defaults to ['Open'] (available only).",
  },
  team: {
    type: "string",
    description:
      "Filter to games involving this team (matches home, away, or aug team; partial name OK, e.g. 'Lakers').",
  },
  aug_conference: {
    type: "string",
    enum: ["Western", "Eastern"],
    description:
      "Filter to games where the augmented (inventory) team is in this NBA conference. " +
      "Use 'Western' for west-coast RFPs targeting Pacific aug teams (Warriors, Kings, Clippers).",
  },
  aug_timezone: {
    type: "string",
    enum: ["Pacific", "Mountain", "Central", "Eastern"],
    description:
      "Filter to games where the augmented team is in this US timezone. Combine with aug_conference for coastal west inventory.",
  },
  tier: {
    type: "array",
    items: { type: "string" },
    description: "Value tiers to include: 'Tier 1'(.. 'Tier 4') or just '1'..'4'. Tier 1 = highest CPM.",
  },
  date_from: { type: "string", description: "Earliest game date, YYYY-MM-DD (inclusive)." },
  date_to: { type: "string", description: "Latest game date, YYYY-MM-DD (inclusive)." },
  day_of_week: { type: "string", description: "Filter to a single day, e.g. 'Saturday'." },
  national_exclusive: {
    type: "boolean",
    description: "If true, only nationally-exclusive games (no local augmentation inventory); usually you want false.",
  },
};

const TOOLS = [
  {
    name: "list_inventory",
    description:
      "List individual NBA augmentation games with status, tier, CPM, impressions and cost. " +
      "Defaults to upcoming 2027 season (Open inventory). For last-season results, pass season='2026'.",
    inputSchema: {
      type: "object",
      properties: {
        ...FILTER_PROPS,
        limit: { type: "integer", description: "Max games to return (default 50, max 200).", default: 50 },
      },
    },
  },
  {
    name: "inventory_summary",
    description:
      "Aggregate roll-up: counts by status and tier, open inventory value. " +
      "Defaults to upcoming 2027 for availability. " +
      "CRITICAL: For sold/pitched/closed counts or 'last year' questions, pass season='2026' (or season='last'). " +
      "Querying Sold without season returns 0 because 2027 projection is all Open.",
    inputSchema: { type: "object", properties: { ...FILTER_PROPS } },
  },
  {
    name: "get_game",
    description: "Full valuation detail for a single game, by game id or by matchup + date.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "integer", description: "Game id." },
        team: { type: "string", description: "A team in the matchup (used with date if id not given)." },
        date: { type: "string", description: "Game date YYYY-MM-DD (used with team)." },
        season: FILTER_PROPS.season,
        use_projection: FILTER_PROPS.use_projection,
      },
    },
  },
  {
    name: "estimate_package",
    description:
      "Estimate a media package WITHOUT saving it. Defaults to upcoming 2027 Open inventory. " +
      "Use budget (USD) for spend-constrained RFPs, or target_impressions for an impression goal. " +
      "For historical what-if packages on last season's slate, pass season='2026'.",
    inputSchema: {
      type: "object",
      properties: {
        game_ids: { type: "array", items: { type: "integer" }, description: "Explicit game ids to include." },
        ...FILTER_PROPS,
        budget: {
          type: "number",
          description: "Maximum total package cost in USD. Auto-selects Open games matching filters until budget is reached.",
        },
        target_impressions: {
          type: "number",
          description: "Impression goal to measure against (default 14,000,000). Used for reporting when budget is set.",
          default: 14000000,
        },
        limit: {
          type: "integer",
          description: "When auto-selecting by filter, max candidate games to consider (default 500).",
          default: 500,
        },
      },
    },
  },
  {
    name: "get_inventory_mode",
    description:
      "Returns the default season catalog: upcoming 2027 projection (Open inventory) unless switched to last season.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "set_inventory_mode",
    description:
      "Change the global default season for queries without an explicit season parameter. " +
      "Default is projection_2027 (upcoming). Switch to current only if you want last season as the default.",
    inputSchema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["current", "projection_2027"],
          description: "current = real inventory statuses; projection_2027 = next-season demo (all Open).",
        },
      },
      required: ["mode"],
    },
  },
  {
    name: "pricing_reference",
    description:
      "Returns the tier→CPM rate card (Tier 1–4 score bands and CPMs) and the logo_placements_per_game setting used to project impressions and cost.",
    inputSchema: { type: "object", properties: {} },
  },
];

// ----------------------------------------------------------------------------
// Tool implementations
// ----------------------------------------------------------------------------

async function listInventory(a: Record<string, unknown>) {
  const limit = Math.min(Number(a.limit ?? 50) || 50, 200);
  const status = (a.status as string[] | undefined) ?? ["Open"];
  const { projection, season, season_auto_inferred } = await resolveSeason(a);
  const table = projection ? "inventory_catalog_projection" : "inventory_catalog";
  let q = sb.from(table).select(GAME_FIELDS);
  q = applyFilters(q, { ...a, status });
  q = q.order("game_date", { ascending: true }).limit(limit);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const rows = data ?? [];
  const inferred =
    season_auto_inferred ? " (auto-selected last season — Sold/Pitched/Closed not on 2027 projection)" : "";
  const summary =
    `${rows.length} game(s) for ${season} season${inferred}` +
    (rows.length === limit ? ` (capped at ${limit})` : "") +
    `, statuses: ${status.join(", ")}.`;
  return { summary, season, season_auto_inferred, inventory_mode: table, games: rows };
}

async function inventorySummary(a: Record<string, unknown>) {
  const { projection, season, season_auto_inferred } = await resolveSeason(a);
  const table = projection ? "inventory_catalog_projection" : "inventory_catalog";
  let q = sb
    .from(table)
    .select("status,tier,cpm,impressions,game_cost,game_date");
  q = applyFilters(q, a); // no status default → summarize everything matching
  const { data, error } = await q.limit(2000);
  if (error) throw new Error(error.message);
  const rows = data ?? [];

  const byStatus: Record<string, number> = {};
  const byTier: Record<string, number> = {};
  let availImpr = 0;
  let availValue = 0;
  for (const r of rows as any[]) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    if (r.tier) byTier[r.tier] = (byTier[r.tier] ?? 0) + 1;
    if (r.status === "Open") {
      availImpr += Number(r.impressions ?? 0);
      availValue += Number(r.game_cost ?? 0);
    }
  }
  const inferred =
    season_auto_inferred ? " Auto-selected 2026 last season (Sold/Pitched/Closed not on 2027 projection)." : "";
  return {
    summary:
      `${rows.length} game(s) for ${season} season. Open: ${byStatus["Open"] ?? 0}, ` +
      `Pitched: ${byStatus["Pitched"] ?? 0}, Sold: ${byStatus["Sold"] ?? 0}, ` +
      `Closed: ${byStatus["Closed"] ?? 0}. ` +
      `Open inventory ≈ ${Math.round(availImpr).toLocaleString("en-US")} impressions, ` +
      `${fmtUSD(availValue)} value.${inferred}`,
    season,
    season_auto_inferred,
    inventory_mode: table,
    total_games: rows.length,
    by_status: byStatus,
    by_tier: byTier,
    open_inventory: {
      impressions: Math.round(availImpr),
      value: Math.round(availValue * 100) / 100,
    },
  };
}

async function getGame(a: Record<string, unknown>) {
  const { projection, season, season_auto_inferred } = await resolveSeason(a);
  const table = projection ? "inventory_catalog_projection" : "inventory_catalog";
  let q = sb.from(table).select(GAME_FIELDS);
  if (a.id != null) {
    q = q.eq("id", a.id);
  } else if (a.team) {
    const t = String(a.team).replace(/[%,]/g, " ");
    q = q.or(`home_team.ilike.%${t}%,away_team.ilike.%${t}%,aug_team.ilike.%${t}%`);
    if (a.date) q = q.eq("game_date", a.date);
  } else {
    throw new Error("Provide an id, or a team (optionally with a date).");
  }
  const { data, error } = await q.limit(10);
  if (error) throw new Error(error.message);
  const rows = data ?? [];
  return { count: rows.length, season, season_auto_inferred, inventory_mode: table, games: rows };
}

async function estimatePackage(a: Record<string, unknown>) {
  const target = Number(a.target_impressions ?? 14000000) || 14000000;
  const budget = a.budget != null ? Number(a.budget) : null;
  const { projection, season, season_auto_inferred } = await resolveSeason(a);
  const table = projection ? "inventory_catalog_projection" : "inventory_catalog";
  let rows: any[] = [];
  if (Array.isArray(a.game_ids) && a.game_ids.length) {
    const { data, error } = await sb
      .from(table)
      .select(GAME_FIELDS)
      .in("id", a.game_ids as number[]);
    if (error) throw new Error(error.message);
    rows = data ?? [];
  } else {
    const limit = Math.min(Number(a.limit ?? 500) || 500, 2000);
    const status = (a.status as string[] | undefined) ?? ["Open"];
    let q = sb.from(table).select(GAME_FIELDS);
    q = applyFilters(q, { ...a, status });
    q = q.order("game_date", { ascending: true }).limit(limit);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    rows = data ?? [];
  }

  if (budget != null && budget > 0) {
    rows = selectByBudget(rows, budget);
  }

  let impr = 0;
  let cost = 0;
  for (const r of rows) {
    impr += Number(r.impressions ?? 0);
    cost += Number(r.game_cost ?? 0);
  }
  const blendedCpm = impr > 0 ? Math.round((cost / impr) * 1000 * 100) / 100 : 0;
  const dates = rows.map((r) => r.game_date).filter(Boolean).sort();

  const budgetNote = budget != null && budget > 0
    ? `${fmtUSD(cost)} of ${fmtUSD(budget)} budget (${Math.round((cost / budget) * 10000) / 100}%). `
    : "";

  return {
    summary:
      `${rows.length} game(s) for ${season} season: ${Math.round(impr).toLocaleString("en-US")} impressions ` +
      `(${((impr / target) * 100).toFixed(0)}% of ${target.toLocaleString("en-US")} target), ` +
      budgetNote +
      `${fmtUSD(cost)} total, ${fmtUSD(blendedCpm)} blended CPM.`,
    season,
    season_auto_inferred,
    inventory_mode: table,
    games_count: rows.length,
    total_impressions: Math.round(impr),
    target_impressions: target,
    pct_of_target: Math.round((impr / target) * 10000) / 100,
    budget: budget ?? null,
    budget_used: budget != null ? Math.round(cost * 100) / 100 : null,
    budget_remaining: budget != null ? Math.round((budget - cost) * 100) / 100 : null,
    pct_of_budget: budget != null && budget > 0 ? Math.round((cost / budget) * 10000) / 100 : null,
    total_cost: Math.round(cost * 100) / 100,
    blended_cpm: blendedCpm,
    flight_start: dates[0] ?? null,
    flight_end: dates[dates.length - 1] ?? null,
    games: rows,
  };
}

async function getInventoryMode() {
  const enabled = await isProjectionEnabled();
  return {
    summary: enabled
      ? "Default season is upcoming 2027 — all inventory Open, dates +1 year."
      : "Default season is last season (2026) — real Sold/Closed/Pitched statuses.",
    season: seasonLabel(enabled),
    mode: enabled ? "projection_2027" : "current",
    projection_2027_enabled: enabled,
  };
}

async function setInventoryMode(a: Record<string, unknown>) {
  const mode = String(a.mode ?? "");
  if (mode !== "current" && mode !== "projection_2027") {
    throw new Error("mode must be 'current' or 'projection_2027'.");
  }
  const enabled = mode === "projection_2027" ? 1 : 0;
  const { error } = await sb
    .from("settings")
    .upsert({ key: "projection_2027_enabled", value: enabled }, { onConflict: "key" });
  if (error) throw new Error(error.message);
  projectionCache = { at: Date.now(), enabled: enabled === 1 };
  return await getInventoryMode();
}

async function pricingReference() {
  const [tiersRes, setRes] = await Promise.all([
    sb.from("tiers").select("tier,score_lo,score_hi,cpm").order("tier"),
    sb.from("settings").select("key,value"),
  ]);
  if (tiersRes.error) throw new Error(tiersRes.error.message);
  if (setRes.error) throw new Error(setRes.error.message);
  const settings: Record<string, number> = {};
  for (const s of setRes.data ?? []) settings[(s as any).key] = Number((s as any).value);
  return {
    summary: "Tier rate card and impression settings.",
    tiers: tiersRes.data,
    logo_placements_per_game: settings["logo_placements_per_game"] ?? null,
    settings,
  };
}

async function callTool(name: string, args: Record<string, unknown>) {
  switch (name) {
    case "list_inventory":
      return await listInventory(args);
    case "inventory_summary":
      return await inventorySummary(args);
    case "get_game":
      return await getGame(args);
    case "estimate_package":
      return await estimatePackage(args);
    case "get_inventory_mode":
      return await getInventoryMode();
    case "set_inventory_mode":
      return await setInventoryMode(args);
    case "pricing_reference":
      return await pricingReference();
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ----------------------------------------------------------------------------
// JSON-RPC / MCP plumbing
// ----------------------------------------------------------------------------

function rpcResult(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}
function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function handleMessage(msg: any): Promise<unknown | null> {
  const { id, method, params } = msg ?? {};

  // Notifications (no id) — acknowledge with no response body.
  if (id === undefined || id === null) {
    return null;
  }

  switch (method) {
    case "initialize":
      return rpcResult(id, {
        protocolVersion: params?.protocolVersion ?? PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions:
          "NBA augmentation inventory for the Genius Sports commercial team. " +
          "TWO SEASONS: (1) UPCOMING 2027 is the DEFAULT — all games Open, dates +1 year. Use for availability, " +
          "RFPs, and package building. (2) LAST SEASON 2026 has real Sold/Pitched/Closed history. " +
          "RULE: Any question about 'sold', 'pitched', 'closed', 'last year', or 'last season' MUST use season='2026' " +
          "or season='last' on inventory_summary/list_inventory. Without it, Sold queries return 0 (2027 is all Open). " +
          "If status filter is Sold/Pitched/Closed only, the server auto-selects 2026. " +
          "Package RFPs: estimate_package with budget (USD). West coast: aug_conference='Western' + aug_timezone='Pacific'.",
      });
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: TOOLS });
    case "tools/call": {
      const toolName = params?.name;
      const args = params?.arguments ?? {};
      try {
        const out = await callTool(toolName, args);
        return rpcResult(id, {
          content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
        });
      } catch (e) {
        return rpcResult(id, {
          content: [{ type: "text", text: `Error: ${(e as Error).message}` }],
          isError: true,
        });
      }
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
  }
  if (req.method === "GET") {
    // No server-initiated streaming in this prototype.
    return new Response("Method Not Allowed", { status: 405, headers: CORS });
  }
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: CORS });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response(
      JSON.stringify(rpcError(null, -32700, "Parse error")),
      { status: 400, headers: { "Content-Type": "application/json", ...CORS } },
    );
  }

  const headers = { "Content-Type": "application/json", ...CORS };

  // Batch
  if (Array.isArray(body)) {
    const out = [];
    for (const m of body) {
      const r = await handleMessage(m);
      if (r !== null) out.push(r);
    }
    if (out.length === 0) return new Response(null, { status: 202, headers: CORS });
    return new Response(JSON.stringify(out), { headers });
  }

  const result = await handleMessage(body);
  if (result === null) {
    // Notification — nothing to return.
    return new Response(null, { status: 202, headers: CORS });
  }
  return new Response(JSON.stringify(result), { headers });
});
