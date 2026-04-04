# ShippingRates MCP Server

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Ocean container shipping intelligence for AI agents — real carrier tariff data, detention & demurrage, freight rates, vessel schedules, and total landed cost across 6 major carriers.

**Remote MCP endpoint:** `https://mcp.shippingrates.org/mcp`

## Overview

ShippingRates gives AI agents access to structured, carrier-sourced data for container shipping decisions — D&D slab breakdowns, local port charges, inland haulage rates, freight rates, vessel schedules, port congestion, and full landed cost calculations.

**Carriers covered:** Maersk · Hapag-Lloyd · MSC · COSCO · ONE · CMA CGM

## Quickstart

Connect any MCP-compatible client to the remote endpoint:

```json
{
  "mcpServers": {
    "shippingrates": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://mcp.shippingrates.org/mcp"]
    }
  }
}
```

> Paid tools require an x402 USDC payment on Base or Solana. Free tools work without any payment.

## Tools (24 total)

### Free (no payment required)

| Tool | Description |
|------|-------------|
| `shippingrates_stats` | Database statistics — record counts, carrier coverage, last updated |
| `shippingrates_lines` | List all shipping lines with country-level breakdowns |
| `shippingrates_search` | Cross-data keyword search across ports, carriers, charges |
| `shippingrates_fx` | Live exchange rates (USD base) |

### Paid (x402 USDC micropayments)

| Tool | Price | Description |
|------|-------|-------------|
| `dd_calculate` | $0.10 | D&D slab breakdown by carrier, port, container type, and days over free time |
| `dd_compare` | $0.25 | Cross-carrier D&D comparison at the same port |
| `local_charges` | $0.05 | THC, documentation, seal, and BL fees by port and carrier |
| `inland_search` | $0.03 | Search inland routes by origin/destination |
| `inland_haulage` | $0.05 | Trucking and rail rates (12 origins, 72 destinations) |
| `inland_compare` | $0.08 | Compare inland rates across carriers |
| `cfs_tariffs` | $0.05 | CFS handling tariffs (APM Terminals — INMAA, INMUN) |
| `port` | $0.01 | Port lookup by UN/LOCODE |
| `transit` | $0.02 | Port-to-port transit times |
| `transit_schedules` | $0.03 | Transit schedules with carrier service codes and frequency |
| `rates` | $0.03 | Ocean spot freight rates with low/mid/high and trend |
| `surcharges` | $0.02 | BAF, CAF, PSS surcharges by carrier |
| `congestion` | $0.02 | Port congestion metrics and historical wait times |
| `congestion_news` | $0.02 | Real-time shipping disruption news from 7 sources |
| `reliability` | $0.02 | Schedule reliability (on-time %) by carrier |
| `vessel_schedule` | $0.02 | Upcoming vessel calls at a port with ETA/ETD |
| `regulatory` | $0.01 | Regulatory updates by country |
| `total_cost` | $0.15 | Full landed cost: freight + surcharges + local charges + D&D |
| `facilities` | $0.02 | India ICD/CFS facility directory |
| `risk_score` | $0.10 | Composite route risk assessment (0–100 score) |

## Example: Calculate D&D for a shipment

```
What are the detention and demurrage charges for a 20ft dry container at Nhava Sheva 
(INNSA) on Maersk if it's been 10 days over free time?
```

The `dd_calculate` tool returns a slab-by-slab breakdown with daily rates, total accrued, and free time details — sourced directly from Maersk's published tariff.

## Payment

Paid tools use the [x402 protocol](https://x402.org) — a standard for HTTP micropayments. When an agent calls a paid tool:

1. The server responds `402 Payment Required` with a USDC payment details
2. The agent pays via Base Mainnet or Solana (USDC)
3. The agent retries with an `X-PAYMENT` header
4. Data is returned

Payment amounts range from $0.01 to $0.25 per call. No subscriptions, no API keys needed for basic access.

## Free Tier

The API also offers a free tier: 25 API requests/month via `api.shippingrates.org`. Sign up at [shippingrates.org](https://shippingrates.org).

## Dashboard

Human-facing dashboard at [app.shippingrates.org](https://app.shippingrates.org) with D&D calculator, carrier comparator, inland routes explorer, vessel schedules, and rate calculator.

## Links

- **Homepage:** https://shippingrates.org
- **API Docs:** https://api.shippingrates.org/docs
- **MCP Endpoint:** https://mcp.shippingrates.org/mcp
- **x402 Discovery:** https://api.shippingrates.org/.well-known/x402.json
- **Agent Discovery:** https://api.shippingrates.org/.well-known/agents.json
- **OpenAPI Spec:** https://api.shippingrates.org/openapi.json

## License

MIT
