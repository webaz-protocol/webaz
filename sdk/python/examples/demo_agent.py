"""WebAZ demo agent — a stranger third-party agent's first task, in ~15 lines.

Run:  pip install webaz  &&  python demo_agent.py
Anonymous, no account. Prints the tool count, browses the catalog, and shows the strict-search
recovery path a natural-language query returns.
"""
import asyncio

from webaz import WebAZ


async def main() -> None:
    async with WebAZ() as wz:  # anonymous; WebAZ(api_key="...") to transact
        print("connected · tools:", len(await wz.tools()))

        # Browse the catalog (filters + no query). Strict search only matches exact titles.
        catalog = await wz.browse(limit=5)
        print(f"\ncatalog ({catalog.get('found', 0)} shown):")
        for p in catalog.get("products", []):
            print(f"  - {p['title'][:48]}  ${p.get('price')}")

        # A natural-language query is strict → 0, but the response tells you how to recover.
        nl = await wz.search("desktop phone stand")
        rec = nl.get("recovery") or {}
        print(f"\nsearch('desktop phone stand') → found={nl.get('found')} "
              f"· recovery sample={len(rec.get('catalog_sample', []))} items "
              f"· next_step={rec.get('next_step', {}).get('description')}")


if __name__ == "__main__":
    asyncio.run(main())
