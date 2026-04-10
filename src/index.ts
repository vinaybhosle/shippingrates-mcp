/**
 * ShippingRates MCP Server v1.3.0
 * Copyright (c) 2026 ShippingRates. All rights reserved.
 *
 * Exposes ShippingRates Shipping Intelligence API as MCP tools
 * for AI agents (Claude, ChatGPT, Cursor, etc.)
 *
 * Free tools: stats, lines, search, fx
 * Paid tools (x402): dd_calculate, dd_compare, local_charges, inland_search,
 *   cfs_tariffs, inland_haulage, port, transit, rates, surcharges, congestion,
 *   reliability, vessel_schedule, regulatory, total_cost
 *
 * CHANGES v1.2.0:
 * - Added 10 new tools: port, transit, rates, surcharges, congestion,
 *   reliability, vessel_schedule, regulatory, total_cost (paid) + fx (free)
 * - Now 19 tools total (4 free + 15 paid) matching full API surface
 *
 * CHANGES v1.1.0:
 * - Dual-chain: Base Mainnet + Solana Mainnet
 * - Tiered pricing: $0.01 - $0.25 per endpoint
 * - PayAI facilitator (free, no API key)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import express from "express";
import { z } from "zod";

// ─── Configuration ───────────────────────────────────────────────────────────

const API_BASE = process.env.SHIPPINGRATES_API_URL || "https://api.shippingrates.org";
const MCP_PORT = parseInt(process.env.MCP_PORT || "3480");
// INTERNAL_KEY: when set, attached to all callApi() requests to bypass x402 on the gateway.
// Only set this in production when the MCP server is used as a trusted proxy (e.g., Apify Actor path).
const INTERNAL_KEY: string | undefined = process.env.INTERNAL_KEY || undefined;

const SHIPPING_LINES = ["maersk", "msc", "cma-cgm", "hapag-lloyd", "one", "cosco"] as const;
const CONTAINER_TYPES = ["20DV", "40DV", "40HC", "20RF", "40RF", "20OT", "40OT", "20FR", "40FR"] as const;

// x402 payment info (for agent awareness)
const X402_INFO = {
  networks: {
    base: "eip155:8453",
    solana: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  },
  asset: "USDC",
  payTo: {
    base: "0x8c9e0882b4c6e6568fe76F16D59F7E080465E5C8",
    solana: "Gcv56hKWuEGmXheBpJxAwQxvX6QAMimZzzVrHaVCbNWE",
  },
  pricing: {
    "dd/calculate": "$0.10",
    "dd/compare": "$0.25",
    "local-charges": "$0.05",
    "inland-search": "$0.03",
    "cfs": "$0.05",
    "inland": "$0.05",
    "port": "$0.01",
    "transit": "$0.02",
    "rates": "$0.03",
    "surcharges": "$0.02",
    "congestion": "$0.02",
    "reliability": "$0.02",
    "vessel-schedule": "$0.02",
    "regulatory": "$0.01",
    "total-cost": "$0.15",
  },
  protocol: "x402 v2",
  facilitator: "https://facilitator.payai.network",
};

// ─── API Client ──────────────────────────────────────────────────────────────

interface ApiResponse {
  status: number;
  data: unknown;
  error?: string;
  x402?: {
    accepts: Array<Record<string, string>>;
  };
}

async function callApi(
  path: string,
  method: "GET" | "POST" = "GET",
  body?: Record<string, unknown>,
  xPayment?: string
): Promise<ApiResponse> {
  const url = `${API_BASE}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "ShippingRates-MCP-Server/1.2.0",
  };

  if (xPayment) {
    headers["X-PAYMENT"] = xPayment;
  }
  if (INTERNAL_KEY) {
    headers["X-Internal-Key"] = INTERNAL_KEY;
  }

  const fetchOptions: RequestInit = {
    method,
    headers,
    signal: AbortSignal.timeout(10000), // 10s timeout
    ...(body && method === "POST" ? { body: JSON.stringify(body) } : {}),
  };

  let res: Response;
  try {
    res = await fetch(url, fetchOptions);
  } catch (error: unknown) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new Error(`API request timed out: ${path}`);
    }
    if (error instanceof TypeError) {
      throw new Error(`API unreachable: ${(error as Error).message}`);
    }
    throw error;
  }
  const text = await res.text();

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  if (res.status === 402) {
    const paymentData = data as Record<string, unknown>;
    return {
      status: 402,
      data: paymentData,
      x402: {
        accepts: (paymentData.accepts as Array<Record<string, string>>) || [],
      },
    };
  }

  if (!res.ok) {
    throw new Error(`API error ${res.status}: ${JSON.stringify(data)}`);
  }

  return { status: res.status, data };
}

function formatPaymentRequired(resource: string, price: string): string {
  return [
    `Payment Required (x402 Protocol v2)`,
    ``,
    `This is a paid endpoint. To access it, send an x402 payment:`,
    `  Price: ${price} USDC`,
    `  Networks: Base Mainnet (eip155:8453) OR Solana Mainnet (solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp)`,
    `  Asset: USDC`,
    `  Base Pay To: ${X402_INFO.payTo.base}`,
    `  Solana Pay To: ${X402_INFO.payTo.solana}`,
    `  Facilitator: ${X402_INFO.facilitator}`,
    `  Resource: ${resource}`,
    ``,
    `Flow: POST request -> receive 402 -> pay via facilitator -> retry with PAYMENT-SIGNATURE header`,
    ``,
    `If you have an x402-compatible wallet, pass the payment proof as the x_payment parameter.`,
  ].join("\n");
}

// ─── MCP Server ──────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "shippingrates-mcp-server",
  version: "1.3.0",
});

// ═══ FREE TOOLS ══════════════════════════════════════════════════════════════

server.registerTool(
  "shippingrates_stats",
  {
    title: "ShippingRates Database Statistics",
    description: `Get current statistics for the ShippingRates shipping intelligence database.

Use this as a starting point to understand what data is available before calling other tools. Returns record counts for D&D tariffs, local charges, transit schedules, freight rates, surcharges, ports, shipping lines, countries, and the last data refresh timestamp.

FREE — no payment required.

Returns: { tariff_records, ports, transit_schedules, freight_rates, local_charges, shipping_lines, countries, last_scrape (ISO datetime) }

Related tools: Use shippingrates_lines for per-carrier breakdowns, shippingrates_search for keyword discovery.`,
    inputSchema: {},
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async () => {
    const { data } = await callApi("/api/stats");
    return {
      content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    };
  }
);

server.registerTool(
  "shippingrates_lines",
  {
    title: "List Shipping Lines",
    description: `List all shipping lines in the ShippingRates database with per-country record counts.

Use this to discover which carriers and countries have data before querying specific tools. Returns each carrier's name, slug, SCAC code, and a breakdown of available D&D tariff and local charge records per country.

FREE — no payment required.

Returns: Array of { line, slug, scac, countries: [{ code, name, dd_records, lc_records }] }

Related tools: Use shippingrates_stats for aggregate totals, shippingrates_search for keyword-based discovery.`,
    inputSchema: {},
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async () => {
    const { data } = await callApi("/api/lines");
    return {
      content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    };
  }
);

server.registerTool(
  "shippingrates_search",
  {
    title: "Search ShippingRates Data",
    description: `Search the ShippingRates database by keyword — matches against carrier names, port names, country names, and charge types.

Use this for exploratory queries when you don't know exact codes. For example, search "mumbai" to find port codes, or "hapag" to find Hapag-Lloyd data coverage. Returns matching trade lanes, local charges, and shipping line information.

FREE — no payment required.

Returns: { trade_lanes: [...], local_charges: [...], lines: [...] } matching the keyword.

Related tools: Use shippingrates_port for structured port lookup by UN/LOCODE, shippingrates_lines for full carrier listing.`,
    inputSchema: {
      keyword: z
        .string()
        .min(1, "Keyword is required")
        .max(100)
        .describe('Search term — e.g. "maersk", "mumbai", "hapag-lloyd"'),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ keyword }: { keyword: string }) => {
    const { data } = await callApi(
      `/api/search?keyword=${encodeURIComponent(keyword)}`
    );
    return {
      content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    };
  }
);

// ═══ PAID TOOLS (x402) ══════════════════════════════════════════════════════

server.registerTool(
  "shippingrates_dd_calculate",
  {
    title: "Calculate Demurrage & Detention Costs",
    description: `Calculate demurrage and detention (D&D) costs for one carrier in one country.

Use this when the user needs a detailed cost breakdown for a specific carrier. Returns free days, per-diem rates for each tariff slab, and total cost. This is the core tool for logistics cost analysis — it answers "how much will I pay if my container is detained X days?"

To compare D&D costs across all carriers at once, use shippingrates_dd_compare instead.

PAID: $0.10/call via x402 (USDC on Base or Solana). Without payment, returns 402 with payment instructions.

Returns: { line, country, container_type, days, free_days, slabs: [{ from, to, rate_per_day, days, cost }], total_cost, currency }`,
    inputSchema: {
      line: z.enum(SHIPPING_LINES).describe("Shipping line slug — one of: maersk, msc, cma-cgm, hapag-lloyd, one, cosco"),
      country: z
        .string()
        .length(2)
        .toUpperCase()
        .describe("ISO 2-letter country code (e.g. IN, AE, SG)"),
      container_type: z.enum(CONTAINER_TYPES).describe("ISO 6346 container type — 20DV, 40DV, 40HC, 20RF, 40RF, 20OT, 40OT, 20FR, 40FR"),
      days: z
        .number()
        .int()
        .min(1)
        .max(365)
        .describe("Number of detention days"),
      x_payment: z
        .string()
        .optional()
        .describe("x402 payment proof header (optional — required for paid access)"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (params: {
    line: string;
    country: string;
    container_type: string;
    days: number;
    x_payment?: string;
  }) => {
    const { line, country, container_type, days, x_payment } = params;
    const result = await callApi(
      "/api/dd/calculate",
      "POST",
      { line, country, container_type, days },
      x_payment
    );

    if (result.status === 402) {
      return {
        content: [
          {
            type: "text" as const,
            text: formatPaymentRequired(`${API_BASE}/api/dd/calculate`, "$0.10"),
          },
        ],
      };
    }

    return {
      content: [{ type: "text" as const, text: JSON.stringify(result.data, null, 2) }],
    };
  }
);

server.registerTool(
  "shippingrates_dd_compare",
  {
    title: "Compare D&D Across Shipping Lines",
    description: `Compare demurrage and detention costs across ALL available carriers for the same country, container type, and detention days.

Use this for freight procurement and carrier selection — it answers "which carrier has the cheapest D&D in this country?" Returns a side-by-side comparison with each carrier's free days, slab rates, and total cost sorted cheapest first.

For a single carrier's detailed D&D breakdown, use shippingrates_dd_calculate instead.

PAID: $0.25/call via x402 (USDC on Base or Solana). Without payment, returns 402 with payment instructions.

Returns: Array of { line, free_days, total_cost, currency, slabs } for each available carrier, sorted by total_cost ascending.`,
    inputSchema: {
      country: z
        .string()
        .length(2)
        .toUpperCase()
        .describe("ISO 2-letter country code"),
      container_type: z.enum(CONTAINER_TYPES).describe("ISO 6346 container type — 20DV, 40DV, 40HC, 20RF, 40RF, 20OT, 40OT, 20FR, 40FR"),
      days: z
        .number()
        .int()
        .min(1)
        .max(365)
        .describe("Number of detention days"),
      x_payment: z
        .string()
        .optional()
        .describe("x402 payment proof header"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (params: {
    country: string;
    container_type: string;
    days: number;
    x_payment?: string;
  }) => {
    const { country, container_type, days, x_payment } = params;
    const result = await callApi(
      "/api/dd/compare",
      "POST",
      { country, container_type, days },
      x_payment
    );

    if (result.status === 402) {
      return {
        content: [
          {
            type: "text" as const,
            text: formatPaymentRequired(`${API_BASE}/api/dd/compare`, "$0.25"),
          },
        ],
      };
    }

    return {
      content: [{ type: "text" as const, text: JSON.stringify(result.data, null, 2) }],
    };
  }
);

server.registerTool(
  "shippingrates_local_charges",
  {
    title: "Get Port Local Charges",
    description: `Get local charges at a port for a specific carrier — Terminal Handling Charges (THC), documentation fees (BL/DO), seal fees, and other port-specific charges.

Use this when calculating total shipping costs at origin or destination. Combine with shippingrates_dd_calculate for a complete port cost picture, or use shippingrates_total_cost for an all-in-one landed cost estimate.

PAID: $0.05/call via x402 (USDC on Base or Solana). Without payment, returns 402 with payment instructions.

Returns: Array of { charge_type, charge_name, amount, currency, container_type, direction } for all applicable charges at the port.`,
    inputSchema: {
      line: z.enum(SHIPPING_LINES).describe("Shipping line slug — one of: maersk, msc, cma-cgm, hapag-lloyd, one, cosco"),
      country: z
        .string()
        .length(2)
        .toUpperCase()
        .describe("ISO 2-letter country code"),
      port_code: z
        .string()
        .optional()
        .describe("Port code to filter (e.g. INMUN for Mumbai)"),
      x_payment: z
        .string()
        .optional()
        .describe("x402 payment proof header"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (params: {
    line: string;
    country: string;
    port_code?: string;
    x_payment?: string;
  }) => {
    const { line, country, port_code, x_payment } = params;
    const body: Record<string, unknown> = { line, country };
    if (port_code) body.port_code = port_code;

    const result = await callApi("/api/local-charges", "POST", body, x_payment);

    if (result.status === 402) {
      return {
        content: [
          {
            type: "text" as const,
            text: formatPaymentRequired(`${API_BASE}/api/local-charges`, "$0.05"),
          },
        ],
      };
    }

    return {
      content: [{ type: "text" as const, text: JSON.stringify(result.data, null, 2) }],
    };
  }
);

server.registerTool(
  "shippingrates_inland_search",
  {
    title: "Search Inland Transport Routes",
    description: `Search for available inland transport routes (road/rail haulage) from port to inland destinations for a specific carrier.

Use this to discover what haulage routes a carrier offers in a country. For example, search "ahmedabad" to find routes from Nhava Sheva to Ahmedabad via Maersk. Returns route options with ICD/CFS codes and available container types.

For actual haulage rate quotes, use shippingrates_inland_haulage. For cross-carrier rate comparison, use shippingrates_inland_compare.

PAID: $0.03/call via x402 (USDC on Base or Solana). Without payment, returns 402 with payment instructions.

Returns: Array of { origin, destination, mode, container_types, icd_code } matching the search criteria.`,
    inputSchema: {
      line: z.enum(SHIPPING_LINES).describe("Shipping line slug — one of: maersk, msc, cma-cgm, hapag-lloyd, one, cosco"),
      country: z
        .string()
        .length(2)
        .toUpperCase()
        .describe("ISO 2-letter country code"),
      keyword: z
        .string()
        .optional()
        .describe("Search term — city name, region, or route"),
      x_payment: z
        .string()
        .optional()
        .describe("x402 payment proof header"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (params: {
    line: string;
    country: string;
    keyword?: string;
    x_payment?: string;
  }) => {
    const { line, country, keyword, x_payment } = params;
    const body: Record<string, unknown> = { line, country };
    if (keyword) body.keyword = keyword;

    const result = await callApi("/api/inland-search", "POST", body, x_payment);

    if (result.status === 402) {
      return {
        content: [
          {
            type: "text" as const,
            text: formatPaymentRequired(`${API_BASE}/api/inland-search`, "$0.03"),
          },
        ],
      };
    }

    return {
      content: [{ type: "text" as const, text: JSON.stringify(result.data, null, 2) }],
    };
  }
);

server.registerTool(
  "shippingrates_cfs_tariffs",
  {
    title: "Get CFS Handling Tariffs",
    description: `Get Container Freight Station (CFS) handling tariffs — charges for LCL (Less than Container Load) cargo consolidation and deconsolidation at port warehouses.

Use this for LCL shipments to estimate warehouse handling costs. Returns per-unit handling rates, minimum charges, and storage fees at the specified port. Not relevant for FCL (Full Container Load) shipments.

PAID: $0.05/call via x402 (USDC on Base or Solana). Without payment, returns 402 with payment instructions.

Returns: Array of { facility, service_type, cargo_type, rate_per_unit, unit, minimum_charge, currency }.`,
    inputSchema: {
      port: z.string().min(2).max(10).toUpperCase().describe("UN/LOCODE port code (e.g. INMAA, INMUN)"),
      service: z.string().optional().describe("Filter by service type"),
      cargo_type: z.string().optional().describe("Filter by cargo type"),
      x_payment: z
        .string()
        .optional()
        .describe("x402 payment proof header"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (params: {
    port: string;
    service?: string;
    cargo_type?: string;
    x_payment?: string;
  }) => {
    const { port, service, cargo_type, x_payment } = params;
    const body: Record<string, unknown> = { port };
    if (service) body.service = service;
    if (cargo_type) body.cargo_type = cargo_type;
    const result = await callApi(
      "/api/cfs",
      "POST",
      body,
      x_payment
    );

    if (result.status === 402) {
      return {
        content: [
          {
            type: "text" as const,
            text: formatPaymentRequired(`${API_BASE}/api/cfs`, "$0.05"),
          },
        ],
      };
    }

    return {
      content: [{ type: "text" as const, text: JSON.stringify(result.data, null, 2) }],
    };
  }
);

server.registerTool(
  "shippingrates_inland_haulage",
  {
    title: "Get Inland Haulage Rates",
    description: `Get inland haulage (trucking/rail) rates for moving containers between a port and an inland location.

Use this when you know the specific origin port and destination and need rate quotes. Returns route-specific rates by container type including base rate, fuel surcharges, and estimated transit times.

To discover what routes exist first, use shippingrates_inland_search. To compare rates across all carriers for the same route, use shippingrates_inland_compare.

PAID: $0.05/call via x402 (USDC on Base or Solana). Without payment, returns 402 with payment instructions.

Returns: Array of { carrier, origin, destination, container_type, rate, fuel_surcharge, total, currency, transit_days, mode }.`,
    inputSchema: {
      origin: z.string().min(2).max(10).toUpperCase().describe("Origin port UN/LOCODE (e.g. INNSA, INMAA)"),
      destination: z.string().min(1).describe("Inland destination city name (e.g. Ahmedabad, Delhi)"),
      container_type: z
        .enum(CONTAINER_TYPES)
        .optional()
        .describe("Container type filter — e.g. 20DV, 40HC, 20RF"),
      mode: z.string().optional().describe("Transport mode filter (PRE or ONC)"),
      x_payment: z
        .string()
        .optional()
        .describe("x402 payment proof header"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (params: {
    origin: string;
    destination: string;
    container_type?: string;
    mode?: string;
    x_payment?: string;
  }) => {
    const { origin, destination, container_type, mode, x_payment } = params;
    const body: Record<string, unknown> = { origin, destination };
    if (container_type) body.container_type = container_type;
    if (mode) body.mode = mode;

    const result = await callApi("/api/inland", "POST", body, x_payment);

    if (result.status === 402) {
      return {
        content: [
          {
            type: "text" as const,
            text: formatPaymentRequired(`${API_BASE}/api/inland`, "$0.05"),
          },
        ],
      };
    }

    return {
      content: [{ type: "text" as const, text: JSON.stringify(result.data, null, 2) }],
    };
  }
);

// ═══ NEW PAID TOOLS (v1.2.0 — GET endpoints) ════════════════════════════════

server.registerTool(
  "shippingrates_port",
  {
    title: "Port Lookup",
    description: `Look up port details by UN/LOCODE — name, country, coordinates, timezone, and terminal facilities.

Use this to validate port codes or get port metadata. If you don't know the UN/LOCODE, use shippingrates_search with the port or city name first.

PAID: $0.01/call via x402 (USDC on Base or Solana). Without payment, returns 402 with payment instructions.

Returns: { port_code, port_name, country, country_code, lat, lon, timezone, facilities }`,
    inputSchema: {
      code: z
        .string()
        .min(2)
        .max(10)
        .toUpperCase()
        .describe('UN/LOCODE port code — e.g. "INNSA", "AEJEA", "SGSIN"'),
      x_payment: z
        .string()
        .optional()
        .describe("x402 payment proof header"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (params: { code: string; x_payment?: string }) => {
    const { code, x_payment } = params;
    const result = await callApi(
      `/api/port?code=${encodeURIComponent(code)}`,
      "GET",
      undefined,
      x_payment
    );
    if (result.status === 402) {
      return {
        content: [{ type: "text" as const, text: formatPaymentRequired(`${API_BASE}/api/port`, "$0.01") }],
      };
    }
    return { content: [{ type: "text" as const, text: JSON.stringify(result.data, null, 2) }] };
  }
);

server.registerTool(
  "shippingrates_transit",
  {
    title: "Transit Time Lookup",
    description: `Get estimated ocean transit times between two ports across all available carriers.

Use this for quick transit time comparison between ports — answers "how long does it take to ship from A to B?" Returns carrier-specific transit durations, service types, and frequencies.

For detailed routing with transhipment ports and service codes, use shippingrates_transit_schedules instead.

PAID: $0.02/call via x402 (USDC on Base or Solana). Without payment, returns 402 with payment instructions.

Returns: Array of { carrier, transit_days, service_type, frequency, direct_or_transhipment }.`,
    inputSchema: {
      origin: z
        .string()
        .min(2)
        .max(10)
        .toUpperCase()
        .describe("Origin port UN/LOCODE — e.g. INNSA (Nhava Sheva), CNSHA (Shanghai), SGSIN (Singapore)"),
      destination: z
        .string()
        .min(2)
        .max(10)
        .toUpperCase()
        .describe("Destination port UN/LOCODE — e.g. AEJEA (Jebel Ali), NLRTM (Rotterdam), USNYC (New York)"),
      x_payment: z
        .string()
        .optional()
        .describe("x402 payment proof header"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (params: { origin: string; destination: string; x_payment?: string }) => {
    const { origin, destination, x_payment } = params;
    const result = await callApi(
      `/api/transit?origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}`,
      "GET",
      undefined,
      x_payment
    );
    if (result.status === 402) {
      return {
        content: [{ type: "text" as const, text: formatPaymentRequired(`${API_BASE}/api/transit`, "$0.02") }],
      };
    }
    return { content: [{ type: "text" as const, text: JSON.stringify(result.data, null, 2) }] };
  }
);

server.registerTool(
  "shippingrates_rates",
  {
    title: "Freight Rates",
    description: `Get ocean freight rates between two ports, optionally filtered by container type.

Use this to compare base freight costs across carriers for a specific trade lane. Returns current spot rates and contract rate indicators with trend data. For a complete cost picture including surcharges and local charges, use shippingrates_total_cost instead.

PAID: $0.03/call via x402 (USDC on Base or Solana). Without payment, returns 402 with payment instructions.

Returns: Array of { carrier, origin, destination, container_type, rate, currency, effective_date, trend }.`,
    inputSchema: {
      origin: z
        .string()
        .min(2)
        .max(10)
        .toUpperCase()
        .describe("Origin port UN/LOCODE — e.g. INNSA (Nhava Sheva), CNSHA (Shanghai), SGSIN (Singapore)"),
      destination: z
        .string()
        .min(2)
        .max(10)
        .toUpperCase()
        .describe("Destination port UN/LOCODE — e.g. AEJEA (Jebel Ali), NLRTM (Rotterdam), USNYC (New York)"),
      container_type: z
        .enum(CONTAINER_TYPES)
        .optional()
        .describe("Container type filter — e.g. 20DV, 40HC, 20RF"),
      x_payment: z
        .string()
        .optional()
        .describe("x402 payment proof header"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (params: { origin: string; destination: string; container_type?: string; x_payment?: string }) => {
    const { origin, destination, container_type, x_payment } = params;
    let qs = `origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}`;
    if (container_type) qs += `&container_type=${encodeURIComponent(container_type)}`;
    const result = await callApi(`/api/rates?${qs}`, "GET", undefined, x_payment);
    if (result.status === 402) {
      return {
        content: [{ type: "text" as const, text: formatPaymentRequired(`${API_BASE}/api/rates`, "$0.03") }],
      };
    }
    return { content: [{ type: "text" as const, text: JSON.stringify(result.data, null, 2) }] };
  }
);

server.registerTool(
  "shippingrates_surcharges",
  {
    title: "Shipping Surcharges",
    description: `Get carrier-specific surcharges — BAF (Bunker Adjustment Factor), CAF (Currency Adjustment Factor), PSS (Peak Season Surcharge), EBS (Emergency Bunker Surcharge), and more.

Use this to understand surcharge exposure for a carrier in a specific country/direction. These are charges added on top of base freight rates. For a complete cost breakdown, use shippingrates_total_cost which includes surcharges automatically.

PAID: $0.02/call via x402 (USDC on Base or Solana). Without payment, returns 402 with payment instructions.

Returns: Array of { surcharge_type, surcharge_name, amount, currency, per_unit, effective_from, effective_to, direction }.`,
    inputSchema: {
      line: z.enum(SHIPPING_LINES).describe("Shipping line slug — one of: maersk, msc, cma-cgm, hapag-lloyd, one, cosco"),
      country: z
        .string()
        .length(2)
        .toUpperCase()
        .optional()
        .describe("ISO 2-letter country code"),
      direction: z
        .enum(["import", "export"])
        .optional()
        .describe("Trade direction — 'import' or 'export'"),
      x_payment: z
        .string()
        .optional()
        .describe("x402 payment proof header"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (params: { line: string; country?: string; direction?: string; x_payment?: string }) => {
    const { line, country, direction, x_payment } = params;
    let qs = `line=${encodeURIComponent(line)}`;
    if (country) qs += `&country=${encodeURIComponent(country)}`;
    if (direction) qs += `&direction=${encodeURIComponent(direction)}`;
    const result = await callApi(`/api/surcharges?${qs}`, "GET", undefined, x_payment);
    if (result.status === 402) {
      return {
        content: [{ type: "text" as const, text: formatPaymentRequired(`${API_BASE}/api/surcharges`, "$0.02") }],
      };
    }
    return { content: [{ type: "text" as const, text: JSON.stringify(result.data, null, 2) }] };
  }
);

server.registerTool(
  "shippingrates_congestion",
  {
    title: "Port Congestion Data",
    description: `Get port congestion metrics — vessel waiting times, berth occupancy, and delay trends for a specific port.

Use this to assess port efficiency and anticipate detention risk. High congestion often leads to longer container dwell times and higher D&D costs. For shipping disruption news and alerts (Red Sea, Suez, chokepoints), use shippingrates_congestion_news instead.

PAID: $0.02/call via x402 (USDC on Base or Solana). Without payment, returns 402 with payment instructions.

Returns: { port, congestion_level, avg_waiting_hours, berth_occupancy_pct, vessel_count, trend, period_days }.`,
    inputSchema: {
      port: z
        .string()
        .min(2)
        .max(10)
        .toUpperCase()
        .describe("UN/LOCODE port code — e.g. INNSA (Nhava Sheva), AEJEA (Jebel Ali), SGSIN (Singapore)"),
      days_back: z
        .number()
        .int()
        .min(1)
        .max(365)
        .optional()
        .describe("Days of historical data (default: 30)"),
      x_payment: z
        .string()
        .optional()
        .describe("x402 payment proof header"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (params: { port: string; days_back?: number; x_payment?: string }) => {
    const { port, days_back, x_payment } = params;
    let qs = `port=${encodeURIComponent(port)}`;
    if (days_back) qs += `&days_back=${days_back}`;
    const result = await callApi(`/api/congestion?${qs}`, "GET", undefined, x_payment);
    if (result.status === 402) {
      return {
        content: [{ type: "text" as const, text: formatPaymentRequired(`${API_BASE}/api/congestion`, "$0.02") }],
      };
    }
    return { content: [{ type: "text" as const, text: JSON.stringify(result.data, null, 2) }] };
  }
);

server.registerTool(
  "shippingrates_reliability",
  {
    title: "Schedule Reliability",
    description: `Get schedule reliability metrics for a carrier — on-time performance percentage, average delay in days, and sample size.

Use this for carrier selection and benchmarking — answers "how reliable is this carrier on this trade lane?" On-time is defined as arriving within ±1 day of scheduled ETA (industry standard per Sea-Intelligence).

PAID: $0.02/call via x402 (USDC on Base or Solana). Without payment, returns 402 with payment instructions.

Returns: { line, trade_lane, on_time_pct, avg_delay_days, sample_size, period }.`,
    inputSchema: {
      line: z.enum(SHIPPING_LINES).describe("Shipping line slug — one of: maersk, msc, cma-cgm, hapag-lloyd, one, cosco"),
      trade_lane: z
        .string()
        .optional()
        .describe("Trade lane filter — e.g. 'Asia-Europe', 'Transpacific', 'Asia-Middle East'"),
      x_payment: z
        .string()
        .optional()
        .describe("x402 payment proof header"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (params: { line: string; trade_lane?: string; x_payment?: string }) => {
    const { line, trade_lane, x_payment } = params;
    let qs = `line=${encodeURIComponent(line)}`;
    if (trade_lane) qs += `&trade_lane=${encodeURIComponent(trade_lane)}`;
    const result = await callApi(`/api/reliability?${qs}`, "GET", undefined, x_payment);
    if (result.status === 402) {
      return {
        content: [{ type: "text" as const, text: formatPaymentRequired(`${API_BASE}/api/reliability`, "$0.02") }],
      };
    }
    return { content: [{ type: "text" as const, text: JSON.stringify(result.data, null, 2) }] };
  }
);

server.registerTool(
  "shippingrates_vessel_schedule",
  {
    title: "Vessel Schedule",
    description: `Get upcoming vessel arrivals and departures at a specific port.

Use this to check what vessels are expected at a port — useful for booking planning and tracking. Returns vessel names, carriers, ETAs/ETDs, and service routes.

For transit time estimates between two ports, use shippingrates_transit. For detailed service-level routing, use shippingrates_transit_schedules.

PAID: $0.02/call via x402 (USDC on Base or Solana). Without payment, returns 402 with payment instructions.

Returns: Array of { vessel_name, carrier, voyage, eta, etd, service, from_port, to_port }.`,
    inputSchema: {
      port: z
        .string()
        .min(2)
        .max(10)
        .toUpperCase()
        .describe("UN/LOCODE port code — e.g. INNSA (Nhava Sheva), AEJEA (Jebel Ali), SGSIN (Singapore)"),
      days_ahead: z
        .number()
        .int()
        .min(1)
        .max(90)
        .optional()
        .describe("Days to look ahead (default: 14)"),
      x_payment: z
        .string()
        .optional()
        .describe("x402 payment proof header"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (params: { port: string; days_ahead?: number; x_payment?: string }) => {
    const { port, days_ahead, x_payment } = params;
    let qs = `port=${encodeURIComponent(port)}`;
    if (days_ahead) qs += `&days_ahead=${days_ahead}`;
    const result = await callApi(`/api/vessel-schedule?${qs}`, "GET", undefined, x_payment);
    if (result.status === 402) {
      return {
        content: [{ type: "text" as const, text: formatPaymentRequired(`${API_BASE}/api/vessel-schedule`, "$0.02") }],
      };
    }
    return { content: [{ type: "text" as const, text: JSON.stringify(result.data, null, 2) }] };
  }
);

server.registerTool(
  "shippingrates_regulatory",
  {
    title: "Regulatory Updates",
    description: `Get recent shipping regulatory updates and compliance requirements for a specific country — customs regulations, documentation requirements, trade restrictions, and policy changes.

Use this to stay current on regulatory changes that may affect shipments to/from a country.

PAID: $0.01/call via x402 (USDC on Base or Solana). Without payment, returns 402 with payment instructions.

Returns: Array of { title, description, effective_date, impact_level, category, country }.`,
    inputSchema: {
      country: z
        .string()
        .length(2)
        .toUpperCase()
        .describe("ISO 2-letter country code"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("Max results (default: 10)"),
      x_payment: z
        .string()
        .optional()
        .describe("x402 payment proof header"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (params: { country: string; limit?: number; x_payment?: string }) => {
    const { country, limit, x_payment } = params;
    let qs = `country=${encodeURIComponent(country)}`;
    if (limit) qs += `&limit=${limit}`;
    const result = await callApi(`/api/regulatory?${qs}`, "GET", undefined, x_payment);
    if (result.status === 402) {
      return {
        content: [{ type: "text" as const, text: formatPaymentRequired(`${API_BASE}/api/regulatory`, "$0.01") }],
      };
    }
    return { content: [{ type: "text" as const, text: JSON.stringify(result.data, null, 2) }] };
  }
);

server.registerTool(
  "shippingrates_total_cost",
  {
    title: "Full Landed Cost Calculator",
    description: `Calculate the full landed cost of shipping a container — combines freight rates, surcharges, local charges (origin + destination), demurrage/detention estimates, and transit time into one comprehensive estimate.

This is the most comprehensive tool — a single call replaces 5-6 individual queries. Use this when the user needs an all-in cost estimate for a specific shipment. For individual cost components, use the dedicated tools: shippingrates_rates (freight), shippingrates_surcharges, shippingrates_local_charges, shippingrates_dd_calculate (detention).

PAID: $0.15/call via x402 (USDC on Base or Solana). Without payment, returns 402 with payment instructions.

Returns: { freight: { rate, currency }, surcharges: { total, items[] }, local_charges: { origin: { total, items[] }, destination: { total, items[] } }, detention: { days, cost, currency }, transit: { days, service }, total_landed_cost, currency }`,
    inputSchema: {
      line: z.enum(SHIPPING_LINES).describe("Shipping line slug — one of: maersk, msc, cma-cgm, hapag-lloyd, one, cosco"),
      origin: z
        .string()
        .min(2)
        .max(10)
        .toUpperCase()
        .describe("Origin port UN/LOCODE — e.g. INNSA (Nhava Sheva), CNSHA (Shanghai), SGSIN (Singapore)"),
      destination: z
        .string()
        .min(2)
        .max(20)
        .describe("Destination port or inland location"),
      container_type: z.enum(CONTAINER_TYPES).describe("ISO 6346 container type — 20DV, 40DV, 40HC, 20RF, 40RF, 20OT, 40OT, 20FR, 40FR"),
      detention_days: z
        .number()
        .int()
        .min(0)
        .max(365)
        .optional()
        .describe("Expected detention days (default: 0)"),
      x_payment: z
        .string()
        .optional()
        .describe("x402 payment proof header"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (params: {
    line: string;
    origin: string;
    destination: string;
    container_type: string;
    detention_days?: number;
    x_payment?: string;
  }) => {
    const { line, origin, destination, container_type, detention_days, x_payment } = params;
    let qs = `line=${encodeURIComponent(line)}&origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}&container_type=${encodeURIComponent(container_type)}`;
    if (detention_days != null) qs += `&detention_days=${detention_days}`;
    const result = await callApi(`/api/total-cost?${qs}`, "GET", undefined, x_payment);
    if (result.status === 402) {
      return {
        content: [{ type: "text" as const, text: formatPaymentRequired(`${API_BASE}/api/total-cost`, "$0.15") }],
      };
    }
    return { content: [{ type: "text" as const, text: JSON.stringify(result.data, null, 2) }] };
  }
);

// ═══ NEW FREE TOOL (v1.2.0) ═════════════════════════════════════════════════

server.registerTool(
  "shippingrates_fx",
  {
    title: "Currency Exchange Rates",
    description: `Get current exchange rate between two currencies — useful for converting shipping costs quoted in different currencies (USD, EUR, INR, AED, SGD, CNY, etc.).

Use this to normalize costs from different carriers/countries to a common currency for comparison. Rates are updated daily.

FREE — no payment required.

Returns: { from, to, rate, timestamp }`,
    inputSchema: {
      from: z
        .string()
        .min(3)
        .max(3)
        .toUpperCase()
        .describe('Source currency code — e.g. "USD", "EUR"'),
      to: z
        .string()
        .min(3)
        .max(3)
        .toUpperCase()
        .describe('Target currency code — e.g. "INR", "AED"'),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (params: { from: string; to: string }) => {
    const { from, to } = params;
    const { data } = await callApi(
      `/api/fx?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`
    );
    return {
      content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    };
  }
);

server.registerTool(
  "shippingrates_transit_schedules",
  {
    title: "Transit Schedules by Carrier",
    description: `Get detailed transit schedules for a specific carrier — service codes, routing via transhipment ports, transit days, and sailing frequency.

Use this when you need routing details beyond just transit time — e.g., which transhipment ports are used, what service string applies, or weekly frequency. For a quick transit time comparison across all carriers, use shippingrates_transit instead.

PAID: $0.03/call via x402 (USDC on Base or Solana). Without payment, returns 402 with payment instructions.

Returns: Array of { carrier, service_code, origin, destination, transit_days, transhipment_ports[], frequency, direct }.`,
    inputSchema: {
      carrier: z.string().min(1).describe("Carrier SCAC code or slug"),
      origin: z.string().optional().describe("Origin port UN/LOCODE filter"),
      destination: z.string().optional().describe("Destination port UN/LOCODE filter"),
      max_days: z.number().int().min(1).optional().describe("Maximum transit days filter"),
      x_payment: z.string().optional().describe("x402 payment proof header"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (params: {
    carrier: string;
    origin?: string;
    destination?: string;
    max_days?: number;
    x_payment?: string;
  }) => {
    const { carrier, origin, destination, max_days, x_payment } = params;
    let qs = `carrier=${encodeURIComponent(carrier)}`;
    if (origin) qs += `&origin=${encodeURIComponent(origin)}`;
    if (destination) qs += `&destination=${encodeURIComponent(destination)}`;
    if (max_days) qs += `&max_days=${max_days}`;
    const result = await callApi(`/api/transit-schedules?${qs}`, "GET", undefined, x_payment);
    if (result.status === 402) {
      return {
        content: [{ type: "text" as const, text: formatPaymentRequired(`${API_BASE}/api/transit-schedules`, "$0.03") }],
      };
    }
    if (result.status === 404) {
      return { content: [{ type: "text" as const, text: `No data found: ${JSON.stringify(result.data)}` }] };
    }
    return { content: [{ type: "text" as const, text: JSON.stringify(result.data, null, 2) }] };
  }
);

server.registerTool(
  "shippingrates_facilities",
  {
    title: "India ICD/CFS Facility Directory",
    description: `Search India's Inland Container Depot (ICD) and Container Freight Station (CFS) facility directory — GPS coordinates, rail connectivity, operator details, and capacity.

Use this to find facilities near an inland destination in India, or to check if a specific ICD/CFS has rail connectivity. Useful for inland logistics planning in combination with shippingrates_inland_haulage.

PAID: $0.02/call via x402 (USDC on Base or Solana). Without payment, returns 402 with payment instructions.

Returns: Array of { code, name, type, state, city, lat, lon, operator, rail_connected, capacity }.`,
    inputSchema: {
      type: z.enum(["ICD", "CFS"]).optional().describe("Facility type filter"),
      state: z.string().optional().describe("Indian state name filter"),
      code: z.string().optional().describe("Facility code filter"),
      rail_connected: z.string().optional().describe("Rail connectivity filter — 'true' or 'false'"),
      x_payment: z.string().optional().describe("x402 payment proof header"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (params: {
    type?: string;
    state?: string;
    code?: string;
    rail_connected?: string;
    x_payment?: string;
  }) => {
    const { type, state, code, rail_connected, x_payment } = params;
    const parts: string[] = [];
    if (type) parts.push(`type=${encodeURIComponent(type)}`);
    if (state) parts.push(`state=${encodeURIComponent(state)}`);
    if (code) parts.push(`code=${encodeURIComponent(code)}`);
    if (rail_connected) parts.push(`rail_connected=${encodeURIComponent(rail_connected)}`);
    const qs = parts.length > 0 ? `?${parts.join("&")}` : "";
    const result = await callApi(`/api/facilities${qs}`, "GET", undefined, x_payment);
    if (result.status === 402) {
      return {
        content: [{ type: "text" as const, text: formatPaymentRequired(`${API_BASE}/api/facilities`, "$0.02") }],
      };
    }
    if (result.status === 404) {
      return { content: [{ type: "text" as const, text: `No data found: ${JSON.stringify(result.data)}` }] };
    }
    return { content: [{ type: "text" as const, text: JSON.stringify(result.data, null, 2) }] };
  }
);

server.registerTool(
  "shippingrates_congestion_news",
  {
    title: "Shipping Disruption News",
    description: `Get shipping disruption news aggregated from 7 trade press sources — with port tagging and severity classification. Covers Hormuz Strait, Red Sea/Houthi, Suez Canal, Bab el-Mandeb, port congestion, and weather events.

Use this for situational awareness — answers "are there any active disruptions affecting my route?" For quantitative port congestion metrics (waiting times, berth occupancy), use shippingrates_congestion instead. For route-level risk scoring, use shippingrates_risk_score.

PAID: $0.02/call via x402 (USDC on Base or Solana). Without payment, returns 402 with payment instructions.

Returns: Array of { headline, source, published_at, severity, affected_ports[], chokepoint, summary }.`,
    inputSchema: {
      port: z.string().optional().describe("Port UN/LOCODE filter"),
      severity: z.enum(["normal", "elevated", "congested"]).optional().describe("Severity classification filter"),
      days_back: z.number().int().min(1).optional().describe("Days of historical news (default: 7)"),
      limit: z.number().int().min(1).optional().describe("Maximum number of results"),
      x_payment: z.string().optional().describe("x402 payment proof header"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (params: {
    port?: string;
    severity?: string;
    days_back?: number;
    limit?: number;
    x_payment?: string;
  }) => {
    const { port, severity, days_back, limit, x_payment } = params;
    const parts: string[] = [];
    if (port) parts.push(`port=${encodeURIComponent(port)}`);
    if (severity) parts.push(`severity=${encodeURIComponent(severity)}`);
    if (days_back) parts.push(`days_back=${days_back}`);
    if (limit) parts.push(`limit=${limit}`);
    const qs = parts.length > 0 ? `?${parts.join("&")}` : "";
    const result = await callApi(`/api/congestion-news${qs}`, "GET", undefined, x_payment);
    if (result.status === 402) {
      return {
        content: [{ type: "text" as const, text: formatPaymentRequired(`${API_BASE}/api/congestion-news`, "$0.02") }],
      };
    }
    if (result.status === 404) {
      return { content: [{ type: "text" as const, text: `No data found: ${JSON.stringify(result.data)}` }] };
    }
    return { content: [{ type: "text" as const, text: JSON.stringify(result.data, null, 2) }] };
  }
);

server.registerTool(
  "shippingrates_inland_compare",
  {
    title: "Compare Inland Haulage Rates",
    description: `Compare inland haulage rates across ALL available carriers for a port-to-ICD/city pair — sorted cheapest first.

Use this for carrier selection on inland legs — answers "which carrier offers the cheapest trucking/rail from port X to city Y?" For a single carrier's rates, use shippingrates_inland_haulage instead. To discover what routes exist, use shippingrates_inland_search first.

PAID: $0.08/call via x402 (USDC on Base or Solana). Without payment, returns 402 with payment instructions.

Returns: Array of { carrier, mode, container_type, rate, currency, transit_days, weight_bracket } sorted by rate ascending.`,
    inputSchema: {
      origin: z.string().min(2).max(10).toUpperCase().describe("Origin port UN/LOCODE — e.g. INNSA (Nhava Sheva), CNSHA (Shanghai), SGSIN (Singapore)"),
      destination: z.string().min(1).describe("Destination city or ICD code"),
      container_type: z.string().optional().describe("Container type (default: 20GP)"),
      x_payment: z.string().optional().describe("x402 payment proof header"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (params: {
    origin: string;
    destination: string;
    container_type?: string;
    x_payment?: string;
  }) => {
    const { origin, destination, container_type, x_payment } = params;
    const body: Record<string, unknown> = { origin, destination };
    if (container_type) body.container_type = container_type;
    const result = await callApi("/api/inland/compare", "POST", body, x_payment);
    if (result.status === 402) {
      return {
        content: [{ type: "text" as const, text: formatPaymentRequired(`${API_BASE}/api/inland/compare`, "$0.08") }],
      };
    }
    if (result.status === 404) {
      return { content: [{ type: "text" as const, text: `No data found: ${JSON.stringify(result.data)}` }] };
    }
    return { content: [{ type: "text" as const, text: JSON.stringify(result.data, null, 2) }] };
  }
);

server.registerTool(
  "shippingrates_risk_score",
  {
    title: "Route Risk Assessment",
    description: `Get a composite risk score (0-100) for a shipping route — combines port congestion, active disruption news, and chokepoint impact analysis (Hormuz, Suez, Bab el-Mandeb, Panama Canal).

Use this for route risk screening — answers "how risky is this trade lane right now?" Scores above 70 indicate elevated risk. For detailed congestion metrics, use shippingrates_congestion. For news detail, use shippingrates_congestion_news.

PAID: $0.10/call via x402 (USDC on Base or Solana). Without payment, returns 402 with payment instructions.

Returns: { origin, destination, risk_score, risk_level, congestion_factor, disruption_factor, chokepoints_affected[], recommendation }.`,
    inputSchema: {
      origin: z.string().min(2).max(10).toUpperCase().describe("Origin port UN/LOCODE — e.g. INNSA (Nhava Sheva), CNSHA (Shanghai), SGSIN (Singapore)"),
      destination: z.string().min(2).max(10).toUpperCase().describe("Destination port UN/LOCODE — e.g. AEJEA (Jebel Ali), NLRTM (Rotterdam), USNYC (New York)"),
      x_payment: z.string().optional().describe("x402 payment proof header"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (params: {
    origin: string;
    destination: string;
    x_payment?: string;
  }) => {
    const { origin, destination, x_payment } = params;
    const qs = `origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}`;
    const result = await callApi(`/api/risk-score?${qs}`, "GET", undefined, x_payment);
    if (result.status === 402) {
      return {
        content: [{ type: "text" as const, text: formatPaymentRequired(`${API_BASE}/api/risk-score`, "$0.10") }],
      };
    }
    if (result.status === 404) {
      return { content: [{ type: "text" as const, text: `No data found: ${JSON.stringify(result.data)}` }] };
    }
    return { content: [{ type: "text" as const, text: JSON.stringify(result.data, null, 2) }] };
  }
);

// ─── Transport Setup ─────────────────────────────────────────────────────────

async function runHTTP(): Promise<void> {
  const app = express();
  app.use(express.json());

  // CORS for cross-origin MCP clients (restrict via MCP_CORS_ORIGINS env var)
  const allowedOrigins = process.env.MCP_CORS_ORIGINS
    ? process.env.MCP_CORS_ORIGINS.split(",").map((s: string) => s.trim())
    : null; // null = allow all (backward compat for MCP protocol which needs open access)
  app.use((_req, res, next) => {
    const origin = _req.headers.origin;
    if (allowedOrigins) {
      if (origin && allowedOrigins.includes(origin)) {
        res.header("Access-Control-Allow-Origin", origin);
      }
      // No origin header (server-to-server, MCP clients) — allow through
      if (!origin) {
        res.header("Access-Control-Allow-Origin", "*");
      }
    } else {
      res.header("Access-Control-Allow-Origin", "*");
    }
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-API-Key");
    if (_req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // Health check — minimal info (don't expose internal config)
  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      server: "shippingrates-mcp-server",
      version: "1.3.0",
      tools: 24,
    });
  });

  // MCP info page
  app.get("/", (_req, res) => {
    res.json({
      name: "ShippingRates MCP Server",
      description:
        "Shipping Intelligence API — 24 tools for AI agents. D&D rates, freight, surcharges, local charges, inland haulage, port data, congestion, transit, regulatory, risk scoring, and more.",
      version: "1.3.0",
      mcp_endpoint: "/mcp",
      tools: {
        free: [
          "shippingrates_stats — Database statistics",
          "shippingrates_lines — Shipping lines listing",
          "shippingrates_search — Search shipping data by keyword",
          "shippingrates_fx — Currency exchange rates",
        ],
        paid_x402: [
          "shippingrates_dd_calculate — D&D cost calculation ($0.10)",
          "shippingrates_dd_compare — Cross-line D&D comparison ($0.25)",
          "shippingrates_local_charges — Port local charges ($0.05)",
          "shippingrates_inland_search — Inland transport routes ($0.03)",
          "shippingrates_cfs_tariffs — CFS handling tariffs ($0.05)",
          "shippingrates_inland_haulage — Inland haulage rates ($0.05)",
          "shippingrates_port — Port lookup ($0.01)",
          "shippingrates_transit — Transit times ($0.02)",
          "shippingrates_rates — Freight rates ($0.03)",
          "shippingrates_surcharges — Surcharges ($0.02)",
          "shippingrates_congestion — Port congestion ($0.02)",
          "shippingrates_reliability — Schedule reliability ($0.02)",
          "shippingrates_vessel_schedule — Vessel schedule ($0.02)",
          "shippingrates_regulatory — Regulatory updates ($0.01)",
          "shippingrates_total_cost — Full landed cost ($0.15)",
          "shippingrates_transit_schedules — Carrier transit schedules ($0.03)",
          "shippingrates_facilities — ICD/CFS facility directory ($0.02)",
          "shippingrates_congestion_news — Disruption news ($0.02)",
          "shippingrates_inland_compare — Compare inland rates ($0.08)",
          "shippingrates_risk_score — Route risk assessment ($0.10)",
        ],
      },
      x402: X402_INFO,
      usage: {
        claude_desktop: {
          mcpServers: {
            shippingrates: {
              url: "https://mcp.shippingrates.org/mcp",
            },
          },
        },
        cursor: {
          mcpServers: {
            shippingrates: {
              url: "https://mcp.shippingrates.org/mcp",
            },
          },
        },
      },
    });
  });

  // Optional API key auth (set MCP_API_KEY env var to enable)
  const MCP_API_KEY = process.env.MCP_API_KEY;
  if (MCP_API_KEY) {
    console.error("  MCP API key authentication: ENABLED");
  }

  // Simple rate limiter for MCP endpoint (per-IP, 120 req/min)
  const mcpRateMap = new Map<string, { count: number; resetAt: number }>();
  const MCP_RATE_LIMIT = 120;
  const MCP_RATE_WINDOW = 60_000;

  // MCP endpoint (Streamable HTTP — stateless JSON)
  app.post("/mcp", async (req, res) => {
    // API key check (if configured)
    if (MCP_API_KEY) {
      const provided = req.headers["x-api-key"] || req.headers["authorization"]?.replace("Bearer ", "");
      if (provided !== MCP_API_KEY) {
        res.status(401).json({ error: "Unauthorized. Provide X-API-Key header or Bearer token." });
        return;
      }
    }

    // Rate limiting
    const ip = (req.headers["cf-connecting-ip"] as string) || req.ip || "unknown";
    const now = Date.now();
    const bucket = mcpRateMap.get(ip);
    if (bucket && now < bucket.resetAt) {
      bucket.count++;
      if (bucket.count > MCP_RATE_LIMIT) {
        res.status(429).json({ error: "Too many requests. Limit: 120 per minute." });
        return;
      }
    } else {
      mcpRateMap.set(ip, { count: 1, resetAt: now + MCP_RATE_WINDOW });
    }
    // Cleanup stale entries periodically
    if (mcpRateMap.size > 5000) {
      for (const [k, v] of mcpRateMap) {
        if (now >= v.resetAt) mcpRateMap.delete(k);
      }
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  // Handle unsupported methods on /mcp
  app.get("/mcp", (_req, res) => {
    res.status(405).json({ error: "Method not allowed. Use POST for MCP requests." });
  });
  app.delete("/mcp", (_req, res) => {
    res.status(405).json({ error: "Method not allowed. Use POST for MCP requests." });
  });


  // Smithery server-card for directory listing
  app.get("/.well-known/mcp/server-card.json", (_req, res) => {
    res.json({
      serverInfo: { name: "ShippingRates MCP Server", version: "1.3.0" },
      tools: [
        { name: "shippingrates_stats", description: "Get API statistics, coverage, and pricing info (free)", inputSchema: { type: "object", properties: {} } },
        { name: "shippingrates_lines", description: "List all supported shipping lines with coverage (free)", inputSchema: { type: "object", properties: {} } },
        { name: "shippingrates_search", description: "Search shipping data by keyword (free)", inputSchema: { type: "object", properties: { keyword: { type: "string" } }, required: ["keyword"] } },
        { name: "shippingrates_fx", description: "Get currency exchange rates (free)", inputSchema: { type: "object", properties: { from: { type: "string" }, to: { type: "string" } }, required: ["from", "to"] } },
        { name: "shippingrates_dd_calculate", description: "Calculate container D&D charges. $0.10/call via x402 USDC.", inputSchema: { type: "object", properties: { line: { type: "string" }, country: { type: "string" }, container_type: { type: "string" }, days: { type: "number" } }, required: ["line", "country", "container_type", "days"] } },
        { name: "shippingrates_dd_compare", description: "Compare D&D across shipping lines. $0.25/call via x402 USDC.", inputSchema: { type: "object", properties: { country: { type: "string" }, container_type: { type: "string" }, days: { type: "number" } }, required: ["country", "container_type", "days"] } },
        { name: "shippingrates_local_charges", description: "Get THC, documentation, and local charges. $0.05/call via x402 USDC.", inputSchema: { type: "object", properties: { line: { type: "string" }, country: { type: "string" } }, required: ["line", "country"] } },
        { name: "shippingrates_inland_search", description: "Search inland transport routes. $0.03/call via x402 USDC.", inputSchema: { type: "object", properties: { line: { type: "string" }, country: { type: "string" }, keyword: { type: "string" } }, required: ["line", "country"] } },
        { name: "shippingrates_cfs_tariffs", description: "Get CFS handling tariffs. $0.05/call via x402 USDC.", inputSchema: { type: "object", properties: { port: { type: "string" }, service: { type: "string" }, cargo_type: { type: "string" } }, required: ["port"] } },
        { name: "shippingrates_inland_haulage", description: "Get inland haulage rates. $0.05/call via x402 USDC.", inputSchema: { type: "object", properties: { origin: { type: "string" }, destination: { type: "string" }, container_type: { type: "string" }, mode: { type: "string" } }, required: ["origin", "destination"] } },
        { name: "shippingrates_port", description: "Port lookup by UN/LOCODE. $0.01/call via x402 USDC.", inputSchema: { type: "object", properties: { code: { type: "string" } }, required: ["code"] } },
        { name: "shippingrates_transit", description: "Transit times between ports. $0.02/call via x402 USDC.", inputSchema: { type: "object", properties: { origin: { type: "string" }, destination: { type: "string" } }, required: ["origin", "destination"] } },
        { name: "shippingrates_rates", description: "Ocean freight rates. $0.03/call via x402 USDC.", inputSchema: { type: "object", properties: { origin: { type: "string" }, destination: { type: "string" }, container_type: { type: "string" } }, required: ["origin", "destination"] } },
        { name: "shippingrates_surcharges", description: "Shipping surcharges (BAF, CAF, etc). $0.02/call via x402 USDC.", inputSchema: { type: "object", properties: { line: { type: "string" }, country: { type: "string" }, direction: { type: "string" } }, required: ["line"] } },
        { name: "shippingrates_congestion", description: "Port congestion metrics. $0.02/call via x402 USDC.", inputSchema: { type: "object", properties: { port: { type: "string" }, days_back: { type: "number" } }, required: ["port"] } },
        { name: "shippingrates_reliability", description: "Schedule reliability metrics. $0.02/call via x402 USDC.", inputSchema: { type: "object", properties: { line: { type: "string" }, trade_lane: { type: "string" } }, required: ["line"] } },
        { name: "shippingrates_vessel_schedule", description: "Upcoming vessel schedules. $0.02/call via x402 USDC.", inputSchema: { type: "object", properties: { port: { type: "string" }, days_ahead: { type: "number" } }, required: ["port"] } },
        { name: "shippingrates_regulatory", description: "Regulatory updates by country. $0.01/call via x402 USDC.", inputSchema: { type: "object", properties: { country: { type: "string" }, limit: { type: "number" } }, required: ["country"] } },
        { name: "shippingrates_total_cost", description: "Full landed cost calculator. $0.15/call via x402 USDC.", inputSchema: { type: "object", properties: { line: { type: "string" }, origin: { type: "string" }, destination: { type: "string" }, container_type: { type: "string" }, detention_days: { type: "number" } }, required: ["line", "origin", "destination", "container_type"] } },
        { name: "shippingrates_transit_schedules", description: "Carrier transit schedules with routing and frequency. $0.03/call via x402 USDC.", inputSchema: { type: "object", properties: { carrier: { type: "string" }, origin: { type: "string" }, destination: { type: "string" }, max_days: { type: "number" } }, required: ["carrier"] } },
        { name: "shippingrates_facilities", description: "India ICD/CFS facility directory. $0.02/call via x402 USDC.", inputSchema: { type: "object", properties: { type: { type: "string" }, state: { type: "string" }, code: { type: "string" }, rail_connected: { type: "string" } }, required: [] } },
        { name: "shippingrates_congestion_news", description: "Shipping disruption news with severity classification. $0.02/call via x402 USDC.", inputSchema: { type: "object", properties: { port: { type: "string" }, severity: { type: "string" }, days_back: { type: "number" }, limit: { type: "number" } }, required: [] } },
        { name: "shippingrates_inland_compare", description: "Compare inland haulage rates across carriers. $0.08/call via x402 USDC.", inputSchema: { type: "object", properties: { origin: { type: "string" }, destination: { type: "string" }, container_type: { type: "string" } }, required: ["origin", "destination"] } },
        { name: "shippingrates_risk_score", description: "Route risk assessment with composite score 0-100. $0.10/call via x402 USDC.", inputSchema: { type: "object", properties: { origin: { type: "string" }, destination: { type: "string" } }, required: ["origin", "destination"] } },
      ],
      resources: [],
      prompts: []
    });
  });

  app.listen(MCP_PORT, () => {
    console.error(`\n  ShippingRates MCP Server v1.3.0`);
    console.error(`  ════════════════════════════════════════`);
    console.error(`  MCP:    http://localhost:${MCP_PORT}/mcp`);
    console.error(`  Health: http://localhost:${MCP_PORT}/health`);
    console.error(`  Info:   http://localhost:${MCP_PORT}/`);
    console.error(`  Tools:  24 (4 free + 20 paid x402)`);
    console.error(`  API:    ${API_BASE}`);
    console.error(`  Networks: Base + Solana (dual-chain)`);
    console.error(`  Pricing: Tiered ($0.01 - $0.25)`);
    console.error(`  ════════════════════════════════════════\n`);
  });
}

async function runStdio(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("ShippingRates MCP Server running on stdio");
}

// Choose transport based on environment
const transportMode = process.env.TRANSPORT || "http";
if (transportMode === "stdio") {
  runStdio().catch((error) => {
    console.error("Server error:", error);
    process.exit(1);
  });
} else {
  runHTTP().catch((error) => {
    console.error("Server error:", error);
    process.exit(1);
  });
}
