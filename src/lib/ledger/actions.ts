import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getSql } from "@/lib/db";
import { authMiddleware } from "@/lib/auth/middleware";
import { num } from "@/lib/money";
import { seedMonthlyBooks2026 } from "./books-2026";
import type { ItemType, Purchase, Sale, Stats, StockRow } from "./types";
import type { Sql } from "@/lib/db";

async function ensureSeeds(sql: Sql, userId: string) {
  await seedMonthlyBooks2026(sql, userId);
}

const itemType = z.enum(["live_fish", "supplies"]);

const purchaseInput = z.object({
  id: z.number().optional(),
  occurredOn: z.string().min(8),
  supplier: z.string().trim().min(1),
  itemType,
  productName: z.string().trim().min(1),
  variety: z.string().trim().optional().nullable(),
  quantity: z.number().positive(),
  unitCost: z.number().min(0),
  shippingCost: z.number().min(0).optional(),
  mortalityCount: z.number().min(0).optional(),
  notes: z.string().trim().optional().nullable(),
});

const saleInput = z.object({
  id: z.number().optional(),
  occurredOn: z.string().min(8),
  customerName: z.string().trim().min(1),
  itemType,
  productName: z.string().trim().min(1),
  variety: z.string().trim().optional().nullable(),
  quantity: z.number().positive(),
  unitCost: z.number().min(0),
  unitPrice: z.number().min(0),
  notes: z.string().trim().optional().nullable(),
});

type PurchaseRow = {
  id: number;
  occurred_on: string;
  supplier: string;
  item_type: ItemType;
  product_name: string;
  variety: string | null;
  quantity: unknown;
  unit_cost: unknown;
  shipping_cost: unknown;
  mortality_count: unknown;
  notes: string | null;
};

type SaleRow = {
  id: number;
  occurred_on: string;
  customer_name: string;
  item_type: ItemType;
  product_name: string;
  variety: string | null;
  quantity: unknown;
  unit_cost: unknown;
  unit_price: unknown;
  notes: string | null;
};

function mapPurchase(r: PurchaseRow): Purchase {
  const quantity = num(r.quantity);
  const unitCost = num(r.unit_cost);
  const shippingCost = num(r.shipping_cost);
  return {
    id: r.id,
    occurredOn: String(r.occurred_on).slice(0, 10),
    supplier: r.supplier,
    itemType: r.item_type,
    productName: r.product_name,
    variety: r.variety,
    quantity,
    unitCost,
    shippingCost,
    mortalityCount: num(r.mortality_count),
    notes: r.notes,
    totalCost: quantity * unitCost + shippingCost,
  };
}

function mapSale(r: SaleRow): Sale {
  const quantity = num(r.quantity);
  const unitCost = num(r.unit_cost);
  const unitPrice = num(r.unit_price);
  return {
    id: r.id,
    occurredOn: String(r.occurred_on).slice(0, 10),
    customerName: r.customer_name,
    itemType: r.item_type,
    productName: r.product_name,
    variety: r.variety,
    quantity,
    unitCost,
    unitPrice,
    notes: r.notes,
    revenue: quantity * unitPrice,
    profit: quantity * (unitPrice - unitCost),
  };
}

function varietyKey(v: string | null | undefined) {
  return v?.trim() ? v.trim() : "";
}

async function applyMortalityDelta(
  sql: Sql,
  userId: string,
  itemType: ItemType,
  productName: string,
  variety: string | null | undefined,
  delta: number,
) {
  if (!delta) return;
  const v = varietyKey(variety);
  const existing = await sql<{ quantity: unknown }>`
    select quantity from stock_mortality
    where user_id = ${userId}
      and item_type = ${itemType}
      and product_name = ${productName}
      and variety = ${v}
  `;
  if (existing.length === 0) return;
  const next = Math.max(0, num(existing[0].quantity) + delta);
  await sql`
    update stock_mortality
    set quantity = ${next}, updated_at = now()
    where user_id = ${userId}
      and item_type = ${itemType}
      and product_name = ${productName}
      and variety = ${v}
  `;
}

async function readPurchaseSlice(sql: Sql, userId: string, id: number) {
  const rows = await sql<{
    item_type: ItemType;
    product_name: string;
    variety: string | null;
    mortality_count: unknown;
  }>`
    select item_type, product_name, variety, mortality_count
    from purchases
    where id = ${id} and user_id = ${userId}
  `;
  return rows[0] ?? null;
}

export const listPurchases = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSql();
    await ensureSeeds(sql, context.userId);
    const rows = await sql<PurchaseRow>`
      select id, occurred_on, supplier, item_type, product_name, variety,
             quantity, unit_cost, shipping_cost, mortality_count, notes
      from purchases
      where user_id = ${context.userId}
      order by occurred_on desc, id desc
    `;
    return rows.map(mapPurchase);
  });

export const listSales = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSql();
    await ensureSeeds(sql, context.userId);
    const rows = await sql<SaleRow>`
      select id, occurred_on, customer_name, item_type, product_name, variety,
             quantity, unit_cost, unit_price, notes
      from sales
      where user_id = ${context.userId}
      order by occurred_on desc, id desc
    `;
    return rows.map(mapSale);
  });
export const savePurchase = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => purchaseInput.parse(input))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const variety = data.variety?.trim() ? data.variety.trim() : null;
    const notes = data.notes?.trim() ? data.notes.trim() : null;
    const shipping = data.shippingCost ?? 0;
    const mortality = data.mortalityCount ?? 0;
    const prev = data.id ? await readPurchaseSlice(sql, context.userId, data.id) : null;
    if (data.id) {
      await sql`
        update purchases set
          occurred_on = ${data.occurredOn},
          supplier = ${data.supplier},
          item_type = ${data.itemType},
          product_name = ${data.productName},
          variety = ${variety},
          quantity = ${data.quantity},
          unit_cost = ${data.unitCost},
          shipping_cost = ${shipping},
          mortality_count = ${mortality},
          notes = ${notes}
        where id = ${data.id} and user_id = ${context.userId}
      `;
    } else {
      await sql`
        insert into purchases (
          user_id, occurred_on, supplier, item_type, product_name, variety,
          quantity, unit_cost, shipping_cost, mortality_count, notes
        ) values (
          ${context.userId}, ${data.occurredOn}, ${data.supplier}, ${data.itemType},
          ${data.productName}, ${variety}, ${data.quantity}, ${data.unitCost},
          ${shipping}, ${mortality}, ${notes}
        )
      `;
    }
    if (prev) {
      const sameItem =
        prev.item_type === data.itemType &&
        prev.product_name === data.productName &&
        varietyKey(prev.variety) === varietyKey(variety);
      if (sameItem) {
        await applyMortalityDelta(
          sql,
          context.userId,
          data.itemType,
          data.productName,
          variety,
          mortality - num(prev.mortality_count),
        );
      } else {
        await applyMortalityDelta(
          sql,
          context.userId,
          prev.item_type,
          prev.product_name,
          prev.variety,
          -num(prev.mortality_count),
        );
        await applyMortalityDelta(
          sql,
          context.userId,
          data.itemType,
          data.productName,
          variety,
          mortality,
        );
      }
    }
    return { ok: true as const };
  });

export const saveSale = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => saleInput.parse(input))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const variety = data.variety?.trim() ? data.variety.trim() : null;
    const notes = data.notes?.trim() ? data.notes.trim() : null;
    if (data.id) {
      await sql`
        update sales set
          occurred_on = ${data.occurredOn},
          customer_name = ${data.customerName},
          item_type = ${data.itemType},
          product_name = ${data.productName},
          variety = ${variety},
          quantity = ${data.quantity},
          unit_cost = ${data.unitCost},
          unit_price = ${data.unitPrice},
          notes = ${notes}
        where id = ${data.id} and user_id = ${context.userId}
      `;
      return { ok: true as const };
    }
    await sql`
      insert into sales (
        user_id, occurred_on, customer_name, item_type, product_name, variety,
        quantity, unit_cost, unit_price, notes
      ) values (
        ${context.userId}, ${data.occurredOn}, ${data.customerName}, ${data.itemType},
        ${data.productName}, ${variety}, ${data.quantity}, ${data.unitCost},
        ${data.unitPrice}, ${notes}
      )
    `;
    return { ok: true as const };
  });

export const deletePurchase = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((id: number) => id)
  .handler(async ({ context, data: id }) => {
    const sql = await getSql();
    const prev = await readPurchaseSlice(sql, context.userId, id);
    await sql`delete from purchases where id = ${id} and user_id = ${context.userId}`;
    if (prev) {
      await applyMortalityDelta(
        sql,
        context.userId,
        prev.item_type,
        prev.product_name,
        prev.variety,
        -num(prev.mortality_count),
      );
    }
    return { ok: true as const };
  });

export const deleteSale = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((id: number) => id)
  .handler(async ({ context, data: id }) => {
    const sql = await getSql();
    await sql`delete from sales where id = ${id} and user_id = ${context.userId}`;
    return { ok: true as const };
  });

const idList = z.array(z.number().int().positive()).min(1);

export const deletePurchases = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => idList.parse(input))
  .handler(async ({ context, data: ids }) => {
    const sql = await getSql();
    const prev = await sql.query<{
      item_type: ItemType;
      product_name: string;
      variety: string | null;
      mortality_count: unknown;
    }>(
      "select item_type, product_name, variety, mortality_count from purchases where user_id = $1 and id = any($2::int[])",
      [context.userId, ids],
    );
    await sql.query(
      "delete from purchases where user_id = $1 and id = any($2::int[])",
      [context.userId, ids],
    );
    for (const row of prev) {
      await applyMortalityDelta(
        sql,
        context.userId,
        row.item_type,
        row.product_name,
        row.variety,
        -num(row.mortality_count),
      );
    }
    return { ok: true as const, count: ids.length };
  });

export const deleteSales = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => idList.parse(input))
  .handler(async ({ context, data: ids }) => {
    const sql = await getSql();
    await sql.query(
      "delete from sales where user_id = $1 and id = any($2::int[])",
      [context.userId, ids],
    );
    return { ok: true as const, count: ids.length };
  });

export const deleteAllPurchases = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSql();
    await sql`delete from purchases where user_id = ${context.userId}`;
    return { ok: true as const };
  });

export const deleteAllSales = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSql();
    await sql`delete from sales where user_id = ${context.userId}`;
    return { ok: true as const };
  });

const periodInput = z.object({
  year: z.number().int().min(2000).max(2100),
  month: z.number().int().min(1).max(12).nullable(),
});

export const getStats = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator((input: unknown) => periodInput.parse(input))
  .handler(async ({ context, data: period }): Promise<Stats> => {
    const sql = await getSql();
    await ensureSeeds(sql, context.userId);
    const purchases = (
      await sql<PurchaseRow>`
        select id, occurred_on, supplier, item_type, product_name, variety,
               quantity, unit_cost, shipping_cost, mortality_count, notes
        from purchases where user_id = ${context.userId}
      `
    ).map(mapPurchase);
    const sales = (
      await sql<SaleRow>`
        select id, occurred_on, customer_name, item_type, product_name, variety,
               quantity, unit_cost, unit_price, notes
        from sales where user_id = ${context.userId}
      `
    ).map(mapSale);

    const years = new Set<number>([period.year]);
    for (const p of purchases) years.add(Number(p.occurredOn.slice(0, 4)));
    for (const s of sales) years.add(Number(s.occurredOn.slice(0, 4)));
    const availableYears = [...years].filter((y) => Number.isFinite(y)).sort((a, b) => a - b);

    const inPeriod = (iso: string) => {
      if (period.month == null) return iso.startsWith(`${period.year}-`);
      const mm = String(period.month).padStart(2, "0");
      return iso.startsWith(`${period.year}-${mm}`);
    };

    const pIn = purchases.filter((p) => inPeriod(p.occurredOn));
    const sIn = sales.filter((s) => inPeriod(s.occurredOn));

    const purchaseTotal = pIn.reduce((s, p) => s + p.totalCost, 0);
    const revenue = sIn.reduce((s, p) => s + p.revenue, 0);
    const profit = sIn.reduce((s, p) => s + p.profit, 0);
    const fishRevenue = sIn.filter((s) => s.itemType === "live_fish").reduce((n, s) => n + s.revenue, 0);
    const suppliesRevenue = revenue - fishRevenue;

    let points: Stats["points"];
    if (period.month == null) {
      points = Array.from({ length: 12 }, (_, i) => {
        const mm = String(i + 1).padStart(2, "0");
        const key = `${period.year}-${mm}`;
        return {
          key,
          label: new Date(period.year, i, 1).toLocaleString("en-IN", { month: "short" }),
          purchases: 0,
          sales: 0,
          profit: 0,
        };
      });
      const byKey = new Map(points.map((p) => [p.key, p]));
      for (const p of pIn) {
        const row = byKey.get(p.occurredOn.slice(0, 7));
        if (row) row.purchases += p.totalCost;
      }
      for (const s of sIn) {
        const row = byKey.get(s.occurredOn.slice(0, 7));
        if (row) {
          row.sales += s.revenue;
          row.profit += s.profit;
        }
      }
    } else {
      const last = new Date(period.year, period.month, 0).getDate();
      const mm = String(period.month).padStart(2, "0");
      points = Array.from({ length: last }, (_, i) => {
        const dd = String(i + 1).padStart(2, "0");
        return {
          key: `${period.year}-${mm}-${dd}`,
          label: String(i + 1),
          purchases: 0,
          sales: 0,
          profit: 0,
        };
      });
      const byKey = new Map(points.map((p) => [p.key, p]));
      for (const p of pIn) {
        const row = byKey.get(p.occurredOn.slice(0, 10));
        if (row) row.purchases += p.totalCost;
      }
      for (const s of sIn) {
        const row = byKey.get(s.occurredOn.slice(0, 10));
        if (row) {
          row.sales += s.revenue;
          row.profit += s.profit;
        }
      }
    }

    const customerMap = new Map<string, { revenue: number; profit: number }>();
    for (const s of sIn) {
      const cur = customerMap.get(s.customerName) ?? { revenue: 0, profit: 0 };
      cur.revenue += s.revenue;
      cur.profit += s.profit;
      customerMap.set(s.customerName, cur);
    }
    const topCustomers = [...customerMap.entries()]
      .map(([name, v]) => ({ name, ...v }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 5);

    const productMap = new Map<string, { revenue: number; profit: number }>();
    for (const s of sIn) {
      const name = s.variety ? `${s.productName} · ${s.variety}` : s.productName;
      const cur = productMap.get(name) ?? { revenue: 0, profit: 0 };
      cur.revenue += s.revenue;
      cur.profit += s.profit;
      productMap.set(name, cur);
    }
    const topProducts = [...productMap.entries()]
      .map(([name, v]) => ({ name, ...v }))
      .sort((a, b) => b.profit - a.profit)
      .slice(0, 5);

    return {
      year: period.year,
      month: period.month,
      availableYears,
      purchaseTotal,
      revenue,
      profit,
      saleCount: sIn.length,
      purchaseCount: pIn.length,
      fishRevenue,
      suppliesRevenue,
      points,
      topCustomers,
      topProducts,
    };
  });

export const getStock = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }): Promise<StockRow[]> => {
    const sql = await getSql();
    await ensureSeeds(sql, context.userId);
    const purchases = (
      await sql<PurchaseRow>`
        select id, occurred_on, supplier, item_type, product_name, variety,
               quantity, unit_cost, shipping_cost, mortality_count, notes
        from purchases where user_id = ${context.userId}
      `
    ).map(mapPurchase);
    const sales = (
      await sql<SaleRow>`
        select id, occurred_on, customer_name, item_type, product_name, variety,
               quantity, unit_cost, unit_price, notes
        from sales where user_id = ${context.userId}
      `
    ).map(mapSale);

    const key = (t: string, p: string, v: string | null) =>
      `${t}||${p}||${v ?? ""}`;
    const map = new Map<
      string,
      {
        itemType: ItemType;
        productName: string;
        variety: string | null;
        bought: number;
        mortality: number;
        sold: number;
        costSum: number;
      }
    >();
    const ensure = (itemType: ItemType, productName: string, variety: string | null) => {
      const k = key(itemType, productName, variety);
      let row = map.get(k);
      if (!row) {
        row = {
          itemType,
          productName,
          variety,
          bought: 0,
          mortality: 0,
          sold: 0,
          costSum: 0,
        };
        map.set(k, row);
      }
      return row;
    };
    for (const p of purchases) {
      const row = ensure(p.itemType, p.productName, p.variety);
      row.bought += p.quantity;
      row.mortality += p.mortalityCount;
      row.costSum += p.quantity * p.unitCost;
    }
    for (const s of sales) {
      const row = ensure(s.itemType, s.productName, s.variety);
      row.sold += s.quantity;
    }
    const recorded = await sql<{
      item_type: ItemType;
      product_name: string;
      variety: string;
      quantity: unknown;
    }>`
      select item_type, product_name, variety, quantity
      from stock_mortality
      where user_id = ${context.userId}
    `;
    for (const m of recorded) {
      const variety = m.variety?.trim() ? m.variety : null;
      const row = ensure(m.item_type, m.product_name, variety);
      row.mortality = num(m.quantity);
    }
    return [...map.values()]
      .map((r) => ({
        itemType: r.itemType,
        productName: r.productName,
        variety: r.variety,
        bought: r.bought,
        mortality: r.mortality,
        sold: r.sold,
        remaining: r.bought - r.mortality - r.sold,
        avgUnitCost: r.bought > 0 ? r.costSum / r.bought : 0,
      }))
      .sort((a, b) => a.productName.localeCompare(b.productName));
  });

export const setStockMortality = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) =>
    z
      .object({
        itemType,
        productName: z.string().trim().min(1),
        variety: z.string().nullable().optional(),
        quantity: z.number().min(0),
      })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const v = varietyKey(data.variety);
    await sql`
      insert into stock_mortality (user_id, item_type, product_name, variety, quantity)
      values (${context.userId}, ${data.itemType}, ${data.productName}, ${v}, ${data.quantity})
      on conflict (user_id, item_type, product_name, variety)
      do update set quantity = excluded.quantity, updated_at = now()
    `;
    return { ok: true as const };
  });
