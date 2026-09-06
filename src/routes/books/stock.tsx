import { AppShell } from "@/components/app-shell";
import { PageSummary } from "@/components/page-summary";
import { RequireAuth } from "@/components/require-auth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getStock, setStockMortality } from "@/lib/ledger/actions";
import { itemTypeLabel, type StockRow } from "@/lib/ledger/types";
import { inr, qty } from "@/lib/money";
import { cn } from "@/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

export const Route = createFileRoute("/books/stock")({ component: Page });

type Filter = "on_hand" | "all" | "live_fish" | "supplies";

function Page() {
  return (
    <RequireAuth>
      <AppShell>
        <Stock />
      </AppShell>
    </RequireAuth>
  );
}

function Stock() {
  const list = useQuery({ queryKey: ["stock"], queryFn: () => getStock() });
  const [filter, setFilter] = useState<Filter>("on_hand");
  const rows = list.data ?? [];

  const visible = useMemo(() => {
    return rows
      .filter((r) => {
        if (filter === "on_hand") return r.remaining > 0;
        if (filter === "live_fish") return r.itemType === "live_fish";
        if (filter === "supplies") return r.itemType === "supplies";
        return true;
      })
      .sort((a, b) => b.remaining - a.remaining || a.productName.localeCompare(b.productName));
  }, [rows, filter]);

  const onHand = rows.reduce((s, r) => s + Math.max(0, r.remaining), 0);
  const bought = rows.reduce((s, r) => s + r.bought, 0);
  const died = rows.reduce((s, r) => s + r.mortality, 0);
  const sold = rows.reduce((s, r) => s + r.sold, 0);
  const tankValue = rows.reduce((s, r) => s + Math.max(0, r.remaining) * r.avgUnitCost, 0);

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-[11px] tracking-[0.2em] text-muted-foreground uppercase">In the Den</p>
          <h1 className="font-display mt-1 text-3xl tracking-tight">Stock</h1>
          <PageSummary
            items={[
              { label: "On hand", value: qty(onHand) },
              { label: "Bought", value: qty(bought) },
              { label: "Died", value: qty(died) },
              { label: "Sold", value: qty(sold) },
              { label: "Tank value", value: inr(tankValue) },
            ]}
          />
        </div>
      </div>

      <div className="mt-5 flex flex-wrap gap-2">
        {(
          [
            ["on_hand", "On hand"],
            ["all", "All"],
            ["live_fish", "Live fish"],
            ["supplies", "Supplies"],
          ] as const
        ).map(([id, label]) => (
          <Button
            key={id}
            type="button"
            size="sm"
            variant={filter === id ? "default" : "outline"}
            className="min-h-11"
            onClick={() => setFilter(id)}
          >
            {label}
          </Button>
        ))}
      </div>

      {list.isError && (
        <p className="mt-4 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {list.error.message}
        </p>
      )}

      <p className="mt-4 text-sm text-muted-foreground">
        On hand = bought − died − sold. Type died on a row — it sticks to that stock and updates remaining.
      </p>

      <div className="mt-4 overflow-hidden rounded-2xl border border-border">
        <div className="hidden grid-cols-[1fr_6.5rem_5rem_6.5rem_5rem_6rem_7rem] items-center gap-3 border-b border-border bg-muted/40 px-4 py-2 text-[11px] tracking-widest text-muted-foreground uppercase md:grid">
          <span>Item</span>
          <span>Type</span>
          <span className="text-right">Bought</span>
          <span className="text-right">Died</span>
          <span className="text-right">Sold</span>
          <span className="text-right">On hand</span>
          <span className="text-right">Tank value</span>
        </div>
        {visible.length === 0 && (
          <p className="px-4 py-12 text-center text-sm text-muted-foreground">
            {filter === "on_hand" ? "Nothing on hand. Try All." : "No stock yet. Add a purchase."}
          </p>
        )}
        {visible.map((r) => (
          <StockLine key={`${r.itemType}-${r.productName}-${r.variety ?? ""}`} row={r} />
        ))}
      </div>
    </div>
  );
}

function StockLine({ row }: { row: StockRow }) {
  const name = row.variety ? `${row.productName} · ${row.variety}` : row.productName;
  const value = Math.max(0, row.remaining) * row.avgUnitCost;
  const short = row.remaining < 0;

  return (
    <div className="grid grid-cols-1 gap-2 border-b border-border px-4 py-3 last:border-0 md:grid-cols-[1fr_6.5rem_5rem_6.5rem_5rem_6rem_7rem] md:items-center md:gap-3">
      <div>
        <p className="text-sm font-medium">{name}</p>
        {short && (
          <p className="text-[11px] text-destructive">Sold past what was bought under this name.</p>
        )}
      </div>
      <Badge tone={row.itemType === "live_fish" ? "fish" : "supplies"}>{itemTypeLabel(row.itemType)}</Badge>
      <p className="text-sm tabular-nums md:text-right">{qty(row.bought)}</p>
      <DiedField row={row} />
      <p className="text-sm tabular-nums md:text-right">{qty(row.sold)}</p>
      <p
        className={cn(
          "text-sm font-medium tabular-nums md:text-right",
          short && "text-destructive",
        )}
      >
        {qty(row.remaining)}
      </p>
      <p className="text-sm tabular-nums md:text-right">{row.remaining > 0 ? inr(value) : "—"}</p>
    </div>
  );
}

function DiedField({ row }: { row: StockRow }) {
  const qc = useQueryClient();
  const [value, setValue] = useState(String(row.mortality));
  useEffect(() => {
    setValue(String(row.mortality));
  }, [row.mortality]);

  const save = useMutation({
    mutationFn: (quantity: number) =>
      setStockMortality({
        data: {
          itemType: row.itemType,
          productName: row.productName,
          variety: row.variety,
          quantity,
        },
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["stock"] });
      await qc.invalidateQueries({ queryKey: ["purchases"] });
      toast.success("Died updated");
    },
    onError: (e: Error) => {
      setValue(String(row.mortality));
      toast.error(e.message);
    },
  });

  function commit() {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) {
      setValue(String(row.mortality));
      return;
    }
    if (n === row.mortality) return;
    save.mutate(n);
  }

  return (
    <label className="flex items-center gap-2 md:justify-end">
      <span className="text-[11px] tracking-wide text-muted-foreground uppercase md:hidden">Died</span>
      <Input
        type="number"
        min={0}
        step="1"
        inputMode="numeric"
        aria-label={`Died — ${row.productName}`}
        className="h-11 w-[4.75rem] px-2 text-right tabular-nums"
        value={value}
        disabled={save.isPending}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.currentTarget.blur();
          }
        }}
      />
    </label>
  );
}
