"""Fixture source for grep-defs. Data, not code that runs."""

MAX_ITEMS = 100


class Inventory:
    def __init__(self):
        self.items = {}

    def add(self, sku, count=1):
        self.items[sku] = self.items.get(sku, 0) + count


async def restock(inventory, sku):
    inventory.add(sku, MAX_ITEMS)
