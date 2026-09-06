export const ITEM_TYPES = ["live_fish", "supplies"] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

export function itemTypeLabel(t: ItemType) {
  return t === "live_fish" ? "Live fish" : "Supplies";
}

export type Purchase = {
  id: number;
  occurredOn: string;
  supplier: string;
  itemType: ItemType;
  productName: string;
  variety: string | null;
  quantity: number;
  unitCost: number;
  shippingCost: number;
  mortalityCount: number;
  notes: string | null;
  totalCost: number;
};

export type Sale = {
  id: number;
  occurredOn: string;
  customerName: string;
  itemType: ItemType;
  productName: string;
  variety: string | null;
  quantity: number;
  unitCost: number;
  unitPrice: number;
  notes: string | null;
  revenue: number;
  profit: number;
};

export type PurchaseInput = {
  id?: number;
  occurredOn: string;
  supplier: string;
  itemType: ItemType;
  productName: string;
  variety?: string;
  quantity: number;
  unitCost: number;
  shippingCost?: number;
  mortalityCount?: number;
  notes?: string;
};

export type SaleInput = {
  id?: number;
  occurredOn: string;
  customerName: string;
  itemType: ItemType;
  productName: string;
  variety?: string;
  quantity: number;
  unitCost: number;
  unitPrice: number;
  notes?: string;
};

export type PeriodPoint = {
  key: string;
  label: string;
  purchases: number;
  sales: number;
  profit: number;
};

export type Stats = {
  year: number;
  month: number | null;
  availableYears: number[];
  purchaseTotal: number;
  revenue: number;
  profit: number;
  saleCount: number;
  purchaseCount: number;
  fishRevenue: number;
  suppliesRevenue: number;
  points: PeriodPoint[];
  topCustomers: { name: string; revenue: number; profit: number }[];
  topProducts: { name: string; revenue: number; profit: number }[];
};

export type StockRow = {
  itemType: ItemType;
  productName: string;
  variety: string | null;
  bought: number;
  mortality: number;
  sold: number;
  remaining: number;
  avgUnitCost: number;
};

