import { AppShell } from "@/components/app-shell";
import { BulkBar } from "@/components/bulk-bar";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { SaleForm } from "@/components/forms/sale-form";
import { PageSummary } from "@/components/page-summary";
import { RequireAuth } from "@/components/require-auth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { deleteAllSales, deleteSale, deleteSales, listSales, saveSale } from "@/lib/ledger/actions";
import { itemTypeLabel, type Sale, type SaleInput } from "@/lib/ledger/types";
import { inr, qty } from "@/lib/money";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { format, parseISO } from "date-fns";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

export const Route = createFileRoute("/books/sales")({ component: Page });

function Page() {
  return (
    <RequireAuth>
      <AppShell>
        <Sales />
      </AppShell>
    </RequireAuth>
  );
}

function Sales() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["sales"], queryFn: () => listSales() });
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Sale | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [confirm, setConfirm] = useState<"selected" | "all" | null>(null);

  const rows = list.data ?? [];
  const ids = useMemo(() => rows.map((r) => r.id), [rows]);
  const allSelected = rows.length > 0 && selected.size === rows.length;
  const someSelected = selected.size > 0 && !allSelected;
  const revenue = rows.reduce((s, r) => s + r.revenue, 0);
  const profit = rows.reduce((s, r) => s + r.profit, 0);

  function toggle(id: number, on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  const save = useMutation({
    mutationFn: (d: SaleInput) => saveSale({ data: d }),
    onSuccess: async () => {
      await qc.invalidateQueries();
      setOpen(false);
      setEditing(null);
      toast.success("Sale saved");
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const del = useMutation({
    mutationFn: (id: number) => deleteSale({ data: id }),
    onSuccess: async (_, id) => {
      await qc.invalidateQueries();
      setSelected((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      toast.success("Sale removed");
    },
  });
  const bulk = useMutation({
    mutationFn: async () => {
      if (confirm === "all") return deleteAllSales();
      return deleteSales({ data: [...selected] });
    },
    onSuccess: async () => {
      await qc.invalidateQueries();
      setSelected(new Set());
      setConfirm(null);
      toast.success(confirm === "all" ? "All sales deleted" : "Selected sales deleted");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-[11px] tracking-[0.2em] text-muted-foreground uppercase">Out</p>
          <h1 className="font-display mt-1 text-3xl tracking-tight">Sales</h1>
          <PageSummary
            items={[
              { label: "Sales", value: String(rows.length) },
              { label: "Billed", value: inr(revenue) },
              { label: "Profit", value: inr(profit) },
            ]}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <BulkBar
            total={rows.length}
            selected={selected.size}
            noun="sales"
            onSelectAll={() => setSelected(new Set(ids))}
            onClear={() => setSelected(new Set())}
            onDeleteSelected={() => setConfirm("selected")}
            onDeleteAll={() => setConfirm("all")}
          />
          <Button
            onClick={() => {
              setEditing(null);
              setOpen(true);
            }}
          >
            <Plus />
            Add sale
          </Button>
        </div>
      </div>

      {list.isError && (
        <p className="mt-4 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {list.error.message}
        </p>
      )}

      <div className="mt-6 overflow-hidden rounded-2xl border border-border">
        <div className="hidden grid-cols-[2.75rem_7rem_1fr_1fr_4rem_7rem_7rem_5.5rem] items-center gap-3 border-b border-border bg-muted/40 px-2 py-1 text-[11px] tracking-widest text-muted-foreground uppercase md:grid">
          <Checkbox
            checked={allSelected}
            indeterminate={someSelected}
            label="Select all sales"
            onCheckedChange={(on) => setSelected(on ? new Set(ids) : new Set())}
          />
          <span>Date</span>
          <span>Customer</span>
          <span>Item</span>
          <span className="text-right">Qty</span>
          <span className="text-right">Sale</span>
          <span className="text-right">Profit</span>
          <span />
        </div>
        {rows.length === 0 && (
          <p className="px-4 py-12 text-center text-sm text-muted-foreground">No sales yet.</p>
        )}
        {rows.map((r) => (
          <div
            key={r.id}
            className="grid grid-cols-[2.75rem_1fr] items-start gap-1 border-b border-border px-2 py-3 last:border-0 md:grid-cols-[2.75rem_7rem_1fr_1fr_4rem_7rem_7rem_5.5rem] md:items-center md:gap-3"
          >
            <Checkbox
              checked={selected.has(r.id)}
              label={`Select sale ${r.id}`}
              onCheckedChange={(on) => toggle(r.id, on)}
            />
            <div className="md:contents">
              <p className="text-xs tabular-nums text-muted-foreground">
                {format(parseISO(r.occurredOn), "d MMM yy")}
              </p>
              <p className="text-sm font-medium">{r.customerName}</p>
              <div>
                <p className="text-sm">
                  {r.productName}
                  {r.variety ? ` · ${r.variety}` : ""}
                </p>
                <Badge tone={r.itemType === "live_fish" ? "fish" : "supplies"}>
                  {itemTypeLabel(r.itemType)}
                </Badge>
              </div>
              <p className="text-sm tabular-nums md:text-right">{qty(r.quantity)}</p>
              <p className="text-sm tabular-nums md:text-right">{inr(r.revenue)}</p>
              <p className="text-sm tabular-nums md:text-right">{inr(r.profit)}</p>
              <div className="flex gap-1 md:justify-end">
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => {
                    setEditing(r);
                    setOpen(true);
                  }}
                >
                  <Pencil />
                </Button>
                <Button size="icon" variant="ghost" onClick={() => del.mutate(r.id)}>
                  <Trash2 />
                </Button>
              </div>
            </div>
          </div>
        ))}
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogTitle>{editing ? "Edit sale" : "New sale"}</DialogTitle>
          <SaleForm
            key={editing?.id ?? "new"}
            initial={editing}
            pending={save.isPending}
            onCancel={() => setOpen(false)}
            onSubmit={(d) => save.mutate(d)}
          />
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirm !== null}
        title={confirm === "all" ? "Delete all sales?" : "Delete selected sales?"}
        body={
          confirm === "all"
            ? `This removes all ${rows.length} sale lines. Profit and charts will update.`
            : `This removes ${selected.size} selected sale line${selected.size === 1 ? "" : "s"}.`
        }
        confirmLabel={confirm === "all" ? "Delete all" : "Delete selected"}
        pending={bulk.isPending}
        onClose={() => setConfirm(null)}
        onConfirm={() => bulk.mutate()}
      />
    </div>
  );
}
