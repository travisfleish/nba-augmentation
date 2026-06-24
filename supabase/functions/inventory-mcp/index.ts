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

// Apply common filters to a query against the game_valuation view.
function applyFilters(q: any, a: Record<string, unknown>) {
  const status = a.status as string[] | undefined;
  if (status && status.length) q = q.in("status", status);

  const tiers = normalizeTiers(a.tier as string[] | undefined);
  if (tiers && tiers.length) q = q.in("tier", tiers);

  if (a.team) {
    const t = String(a.team).replace(/[%,]/g, " ");
    q = q.or(`home_team.ilike.%${t}%,away_team.ilike.%${t}%`);
  }
  if (a.date_from) q = q.gte("game_date", a.date_from);
  if (a.date_to) q = q.lte("game_date", a.date_to);
  if (a.day_of_week) q = q.eq("day_of_week", a.day_of_week);
  if (typeof a.national_exclusive === "boolean") {
    q = q.eq("national_exclusive", a.national_exclusive);
  }
  return q;
}

const GAME_FIELDS =
  "id,game_date,game_time_et,day_of_week,home_team,away_team,aug_team,opp_team,home_rsn,away_rsn,status,brand_contact,national_exclusive,tier,cpm,tier_score,impressions,game_cost";

function fmtUSD(n: number): string {
  return "$" + Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 });
}

// ----------------------------------------------------------------------------
// Tool definitions
// ----------------------------------------------------------------------------

const FILTER_PROPS = {
  status: {
    type: "array",
    items: { type: "string", enum: STATUSES },
    description:
      "Inventory statuses to include. Open = available, Pitched = offered to a brand, Sold = booked, Closed/N/A = unavailable. Defaults to ['Open'] (available only).",
  },
  team: {
    type: "string",
    description: "Filter to games involving this team (matches home or away, partial name OK, e.g. 'Lakers').",
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
      "List individual NBA augmentation games with their status, value tier, CPM, projected impressions and cost. Use to answer 'what's available', 'what Lakers inventory is open in November', etc. Defaults to Open (available) games only.",
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
      "Aggregate roll-up of inventory matching the filters: counts by status and by tier, total projected impressions and total value (sum of game cost) for available games. Use for 'how much inventory is left', 'what's our open inventory worth'.",
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
      },
    },
  },
  {
    name: "estimate_package",
    description:
      "Estimate a media package WITHOUT saving it. Provide either explicit game_ids OR filter criteria to auto-select games, plus an impression target. Returns the games included, total projected impressions vs target, total cost, blended CPM, and flight dates. Mirrors the app's Package Builder math.",
    inputSchema: {
      type: "object",
      properties: {
        game_ids: { type: "array", items: { type: "integer" }, description: "Explicit game ids to include." },
        ...FILTER_PROPS,
        target_impressions: {
          type: "number",
          description: "Impression goal to measure against (default 14,000,000).",
          default: 14000000,
        },
        limit: { type: "integer", description: "When auto-selecting by filter, cap games considered (default 100).", default: 100 },
      },
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
  let q = sb.from("game_valuation").select(GAME_FIELDS);
  q = applyFilters(q, { ...a, status });
  q = q.order("game_date", { ascending: true }).limit(limit);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const rows = data ?? [];
  const summary =
    `${rows.length} game(s)` +
    (rows.length === limit ? ` (capped at ${limit})` : "") +
    `, statuses: ${status.join(", ")}.`;
  return { summary, games: rows };
}

async function inventorySummary(a: Record<string, unknown>) {
  let q = sb
    .from("game_valuation")
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
  return {
    summary:
      `${rows.length} game(s) match. Open: ${byStatus["Open"] ?? 0}, ` +
      `Pitched: ${byStatus["Pitched"] ?? 0}, Sold: ${byStatus["Sold"] ?? 0}. ` +
      `Open inventory ≈ ${Math.round(availImpr).toLocaleString("en-US")} impressions, ` +
      `${fmtUSD(availValue)} value.`,
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
  let q = sb.from("game_valuation").select(GAME_FIELDS);
  if (a.id != null) {
    q = q.eq("id", a.id);
  } else if (a.team) {
    const t = String(a.team).replace(/[%,]/g, " ");
    q = q.or(`home_team.ilike.%${t}%,away_team.ilike.%${t}%`);
    if (a.date) q = q.eq("game_date", a.date);
  } else {
    throw new Error("Provide an id, or a team (optionally with a date).");
  }
  const { data, error } = await q.limit(10);
  if (error) throw new Error(error.message);
  const rows = data ?? [];
  return { count: rows.length, games: rows };
}

async function estimatePackage(a: Record<string, unknown>) {
  const target = Number(a.target_impressions ?? 14000000) || 14000000;
  let rows: any[] = [];
  if (Array.isArray(a.game_ids) && a.game_ids.length) {
    const { data, error } = await sb
      .from("game_valuation")
      .select(GAME_FIELDS)
      .in("id", a.game_ids as number[]);
    if (error) throw new Error(error.message);
    rows = data ?? [];
  } else {
    const limit = Math.min(Number(a.limit ?? 100) || 100, 200);
    const status = (a.status as string[] | undefined) ?? ["Open"];
    let q = sb.from("game_valuation").select(GAME_FIELDS);
    q = applyFilters(q, { ...a, status });
    q = q.order("game_date", { ascending: true }).limit(limit);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    rows = data ?? [];
  }

  let impr = 0;
  let cost = 0;
  for (const r of rows) {
    impr += Number(r.impressions ?? 0);
    cost += Number(r.game_cost ?? 0);
  }
  const blendedCpm = impr > 0 ? Math.round((cost / impr) * 1000 * 100) / 100 : 0;
  const dates = rows.map((r) => r.game_date).filter(Boolean).sort();

  return {
    summary:
      `${rows.length} game(s): ${Math.round(impr).toLocaleString("en-US")} impressions ` +
      `(${((impr / target) * 100).toFixed(0)}% of ${target.toLocaleString("en-US")} target), ` +
      `${fmtUSD(cost)} total, ${fmtUSD(blendedCpm)} blended CPM.`,
    games_count: rows.length,
    total_impressions: Math.round(impr),
    target_impressions: target,
    pct_of_target: Math.round((impr / target) * 10000) / 100,
    total_cost: Math.round(cost * 100) / 100,
    blended_cpm: blendedCpm,
    flight_start: dates[0] ?? null,
    flight_end: dates[dates.length - 1] ?? null,
    games: rows,
  };
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
          "NBA augmentation inventory for the Genius Sports commercial team. Ask about available games, " +
          "inventory by team/date/tier, pricing tiers, or estimate a media package. Data is read-only.",
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
