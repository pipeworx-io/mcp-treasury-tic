# @pipeworx/treasury-tic

Foreign holdings of U.S. securities, by country and month, from the U.S.
Treasury's Treasury International Capital (TIC) System — the capital-flows
survey behind "China holds $X of US Treasuries" headlines. This is a
different Treasury system from the daily fiscal ledger the `treasury-fiscal`
pack covers, and a series FRED does not carry.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1837+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `tic_foreign_holdings(country?, month?, limit?)` — foreign holdings of U.S.
  long-term securities (Treasury, agency bonds, corporate bonds, corporate
  equity) by country and month. Pass `country` for one country's recent
  history; omit it for a ranking of the largest foreign holders in a given
  month.
- `tic_major_treasury_holders(country?, month?, limit?)` — the "Major Foreign
  Holders of Treasury Securities" ranking: the ~20 largest individual foreign
  holders of U.S. Treasury securities plus an "All Other" bucket, the grand
  total, and the foreign-official-sector (central bank/government) split.
  This is the specific number financial press quotes per country.

## Auth

Keyless. The upstream answers without a credential, and no `_apiKey` is
accepted.

## Data sources

- U.S. Department of the Treasury, Treasury International Capital (TIC)
  System — the monthly survey of foreign holdings of U.S. long-term
  securities, broken out by country and security type, and the Major Foreign
  Holders of Treasury Securities ranking derived from it. U.S. federal
  government data; no reuse restriction.

## Cadence and coverage

- Monthly, published roughly 6 weeks after the reference month (e.g.
  August data in mid-October).
- `tic_foreign_holdings` covers essentially every country and a set of
  regional/institutional-sector aggregates (totals, "Of Which:" breakouts),
  back to 2011 or earlier for most countries.
- `tic_major_treasury_holders` only names the ~20 largest individual
  holders; everyone else is folded into "All Other". Asking it for a smaller
  country returns `found: false` with a pointer to `tic_foreign_holdings`
  instead, which does cover that country.

## Common pitfalls

- **These two tools answer different questions.** `tic_foreign_holdings`'s
  `treasury_holdings_usd_mil` for a country and `tic_major_treasury_holders`'s
  `holdings_usd_bil` for the same country/month should be close (same
  underlying survey) but are not guaranteed byte-identical — the Major
  Foreign Holders ranking is Treasury's own derived table, not a mechanical
  re-slice of Table 1.
- **Units differ**: `tic_foreign_holdings` reports USD millions,
  `tic_major_treasury_holders` reports USD billions — each response carries
  its own `unit` field, read it rather than assuming.
- **A country name has to resolve to the publisher's own label.** "China"
  resolves to "China, Mainland" via a small alias table; an unresolvable name
  returns `found: false` with suggestions rather than an empty result.
- **Revisions happen.** Both files are refetched live on every call, so a
  mid-month correction to a prior month's figure shows up immediately rather
  than being frozen at whatever we first saw.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "treasury-tic": {
      "url": "https://gateway.pipeworx.io/treasury-tic/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/treasury-tic/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1837+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/tic_foreign_holdings \
  -H 'Content-Type: application/json' \
  -d '{"limit":5}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/tic_foreign_holdings`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "treasury-tic": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-treasury-tic"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-treasury-tic
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Treasury Tic data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
