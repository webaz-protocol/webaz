"""WebAZ Python SDK — connect any Python agent to WebAZ in one import.

Thin, ergonomic async wrapper over the official MCP Python SDK's Streamable HTTP client, pre-wired to
the WebAZ Remote MCP endpoint (https://webaz.xyz/mcp). Anonymous by default (public read-only tools);
pass api_key for authenticated writes (risk actions still return an approve_url for a human Passkey).

    import asyncio
    from webaz import WebAZ

    async def main():
        async with WebAZ() as wz:              # anonymous; WebAZ(api_key="...") to transact
            print(await wz.tools())            # tool names
            print(await wz.browse())           # list the catalog (strict search only on exact title)
            print(await wz.search("Magnetic Foldable Phone Ring Stand Colorful Desktop Holder"))

    asyncio.run(main())
"""
from __future__ import annotations

import json
from contextlib import AsyncExitStack
from typing import Any

from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

__all__ = ["WebAZ"]
__version__ = "0.1.0"

DEFAULT_ENDPOINT = "https://webaz.xyz/mcp"


class WebAZ:
    """Async client for the WebAZ Remote MCP endpoint.

    Use as an async context manager. Anonymous unless `api_key` is given.
    """

    def __init__(self, api_key: str | None = None, endpoint: str = DEFAULT_ENDPOINT) -> None:
        self.endpoint = endpoint
        self._headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
        self._stack: AsyncExitStack | None = None
        self._session: ClientSession | None = None

    async def __aenter__(self) -> "WebAZ":
        self._stack = AsyncExitStack()
        read, write, _ = await self._stack.enter_async_context(
            streamablehttp_client(self.endpoint, headers=self._headers or None)
        )
        self._session = await self._stack.enter_async_context(ClientSession(read, write))
        await self._session.initialize()
        return self

    async def __aexit__(self, *exc: object) -> None:
        if self._stack is not None:
            await self._stack.aclose()
        self._stack = self._session = None

    # ── core ────────────────────────────────────────────────────────────────
    async def tools(self) -> list[str]:
        """Names of the available tools (42+)."""
        assert self._session is not None, "use `async with WebAZ() as wz:`"
        return [t.name for t in (await self._session.list_tools()).tools]

    async def call(self, tool: str, **args: Any) -> Any:
        """Call any WebAZ tool; returns the parsed JSON result (WebAZ tools return JSON text)."""
        assert self._session is not None, "use `async with WebAZ() as wz:`"
        res = await self._session.call_tool(tool, args)
        text = res.content[0].text if res.content else "{}"
        try:
            return json.loads(text)
        except (ValueError, TypeError):
            return {"text": text}

    # ── ergonomic shortcuts ──────────────────────────────────────────────────
    async def info(self) -> Any:
        """Protocol status + network state + tool catalog."""
        return await self.call("webaz_info")

    async def search(self, query: str, **filters: Any) -> Any:
        """STRICT search by exact title/SKU. On 0 hits the result carries a `recovery`
        object (catalog sample + a machine-actionable browse `next_step`)."""
        return await self.call("webaz_search", query=query, **filters)

    async def browse(self, sort: str = "newest", limit: int = 10, **filters: Any) -> Any:
        """Browse the catalog — search with filters and NO query (the remote-reachable discovery)."""
        return await self.call("webaz_search", sort=sort, limit=limit, **filters)

    async def price_history(self, product_id: str) -> Any:
        return await self.call("webaz_price_history", product_id=product_id)
