# WebAZ Python SDK

Connect any Python agent to **WebAZ** — the agent-native commerce protocol — in one import, over Remote MCP. No local process, no boilerplate. Anonymous for reads; an `api_key` for writes.

## Install

```bash
pip install webaz
```

## Quick start (5 minutes, no account)

```python
import asyncio
from webaz import WebAZ

async def main():
    async with WebAZ() as wz:            # anonymous — public read-only tools
        print(await wz.tools())          # 42+ tool names
        catalog = await wz.browse()      # list the catalog (filters + no query)
        for p in catalog["products"]:
            print(p["title"], "$", p["price"])

asyncio.run(main())
```

Run the full demo: `python -m webaz` isn't needed — just:

```bash
python examples/demo_agent.py
```

## Search vs browse

`webaz_search` is **strict** — a `query` matches only an exact title/SKU. A natural-language query
returns `found: 0` **with a `recovery` object** (a labeled catalog sample + a machine-actionable
`next_step`), so your agent never hits a dead end:

```python
await wz.search("Alloy Dual-Sided Tri-Axis Magnetic Ring Stand Metal Phone Holder")  # exact → 1 hit
await wz.search("desktop phone stand")   # → found:0 + result["recovery"]["catalog_sample"]
await wz.browse(sort="newest", limit=5)  # discover by browsing (no query)
```

## Authenticated (writes)

```python
async with WebAZ(api_key="wz...") as wz:   # acts as your account
    ...                                    # order / list / fulfil
```

Risk actions (pay, ship, arbitrate) return an `approve_url` you confirm with your Passkey in the
browser — the endpoint never bypasses the human gate. Get an invite for an `api_key` at
<https://webaz.xyz/#welcome>.

## API

| method | what |
|---|---|
| `await wz.tools()` | list tool names |
| `await wz.call(tool, **args)` | call any tool, returns parsed JSON |
| `await wz.info()` | protocol status + network state |
| `await wz.search(query, **filters)` | strict search (exact title/SKU) |
| `await wz.browse(sort="newest", **filters)` | browse the catalog (no query) |
| `await wz.price_history(product_id)` | product price/volume history |

## How it connects

A thin wrapper over the official [MCP Python SDK](https://github.com/modelcontextprotocol/python-sdk)
Streamable HTTP client, pre-wired to `https://webaz.xyz/mcp`. Same 42-tool surface as every other
WebAZ client. Full transport/auth details: <https://webaz.xyz/docs/REMOTE-MCP.md>. Connect any other
client (Claude, ChatGPT, Cursor, Inspector): <https://webaz.xyz/#connect>.
