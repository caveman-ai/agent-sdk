// Fixture source for grep-defs. Data, not code that runs.
export interface Item {
  sku: string;
  price: number;
}

export type Cart = Item[];

export const TAX_RATE = 0.2;

export function total(cart: Cart): number {
  return cart.reduce((sum, item) => sum + item.price, 0) * (1 + TAX_RATE);
}

export class Checkout {
  constructor(private cart: Cart) {}
}
