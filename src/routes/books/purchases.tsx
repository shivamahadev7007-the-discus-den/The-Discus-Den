import { AppShell } from "@/components/app-shell";
import { BulkBar } from "@/components/bulk-bar";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { PurchaseForm } from "@/components/forms/purchase-form";
import { PageSummary } from "@/components/page-summary";
import { RequireAuth } from "@/components/require-auth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  deleteAllPurchases,
  deletePurchase,
  deletePurchases,
  listPurchases,
  savePurchase,
} from "@/lib/ledger/actions";
import { itemTypeLabel, type Purchase, type PurchaseInput } from "@/lib/ledger/types";
import { inr, qty } from "@/lib/money";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { format, parseISO } from "date-fns";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

export const Route = createFileRoute("/books/purchases")({ component: Page });

function Page() {
  return (
    <RequireAuth>
      <AppShell>
        <Purchases />
      </AppShell>
    </RequireAuth>
  );
}

function Purchases() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["purchases"], queryFn: () => listPurchases() });
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Purchase | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [confirm, setConfirm] = useState<"selected" | "all" | null>(null);

  const rows = list.data ?? [];
  const ids = useMemo(() => rows.map((r) => r.id), [rows]);
  const allSelected = rows.length > 0 && selected.size === rows.length;
  const someSelected = selected.size > 0 && !allSelected;
  const total = rows.reduce((s, r) => s + r.totalCost, 0);

  function toggle(id: number, on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  const save = useMutation({
    mutationFn: (d: PurchaseInput) => savePurchase({ data: d }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["purchases"] });
      qc.invalidateQueries({ queryKey: ["stats"] });
      qc.invalidateQueries({ queryKey: ["stock"] });
      setOpen(false);
      setEditing(null);
      toast.success("Saved");
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const del = useMutation({
    mutationFn: (id: number) => deletePurchase({ data: id }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["purchases"] });
      qc.invalidateQueries({ queryKey: ["stats"] });
      qc.invalidateQueries({ queryKey: ["stock"] });
      toast.success("Deleted");
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const delMany = useMutation({
    mutationFn: (ids: number[]) => deletePurchases({ data: ids }),
    onSuccess: (_, gone) => {
      qc.invalidateQueries({ queryKey: ["purchases"] });
      qc.invalidateQueries({ queryKey: ["stats"] });
      qc.invalidateQueries({ queryKey: ["stock"] });
      setSelected(new Set());
      toast.success(`Deleted ${gone.length}`);
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const delAll = useMutation({
    mutationFn: () => deleteAllPurchases(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["purchases"] });
      qc.invalidateQueries({ queryKey: ["stats"] });
      qc.invalidateQueries({ queryKey: ["stock"] });
      setSelected(new Set());
      toast.success("All purchases deleted");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-[11px] tracking-[0.2em] text-muted-foreground uppercase">In</p>
          <h1 className="font-display mt-1 text-3xl tracking-tight">Purchases</h1>
          <PageSummary
            items={[
              { label: "Purchases", value: String(rows.length) },
              { label: "Spent", value: inr(total) },
              { label: "Died", value: qty(rows.reduce((s, r) => s + r.mortalityCount, 0)) },
            ]}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <BulkBar
            total={rows.length}
            selected={selected.size}
            noun="purchases"
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
            Add purchase
          </Button>
        </div>
      </div>

      {list.isError && (
        <p className="mt-4 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {list.error.message}
        </p>
      )}

      <div className="mt-6 overflow-hidden rounded-2xl border border-border">
        <div className="hidden grid-cols-[2.75rem_7rem_1fr_1fr_4.5rem_4.5rem_7rem_7rem_5.5rem] items-center gap-3 border-b border-border bg-muted/40 px-2 py-1 text-[11px] tracking-widest text-muted-foreground uppercase md:grid">
          <Checkbox
            checked={allSelected}
            indeterminate={someSelected}
            label="Select all purchases"
            onCheckedChange={(on) => setSelected(on ? new Set(ids) : new Set())}
          />
          <span>Date</span>
          <span>Supplier</span>
          <span>Item</span>
          <span className="text-right">Qty</span>
          <span className="text-right">Died</span>
          <span className="text-right">Unit</span>
          <span className="text-right">Total</span>
          <span />
        </div>
        {rows.length === 0 && (
          <p className="px-4 py-12 text-center text-sm text-muted-foreground">No purchases yet.</p>
        )}
        {rows.map((r) => (
          <div
            key={r.id}
            className="grid grid-cols-[2.75rem_1fr] items-start gap-1 border-b border-border px-2 py-3 last:border-0 md:grid-cols-[2.75rem_7rem_1fr_1fr_4.5rem_4.5rem_7rem_7rem_5.5rem] md:items-center md:gap-3"
          >
            <Checkbox
              checked={selected.has(r.id)}
              label={`Select purchase ${r.id}`}
              onCheckedChange={(on) => toggle(r.id, on)}
            />
            <div className="md:contents">
              <p className="text-xs tabular-nums text-muted-foreground">
                {format(parseISO(r.occurredOn), "d MMM yy")}
              </p>
              <p className="text-sm font-medium">{r.supplier}</p>
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
              <p className="text-sm tabular-nums text-muted-foreground md:text-right">
                {r.mortalityCount ? qty(r.mortalityCount) : "—"}
              </p>
              <p className="text-sm tabular-nums md:text-right">{inr(r.unitCost)}</p>
              <p className="text-sm tabular-nums md:text-right">{inr(r.totalCost)}</p>
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
          <DialogTitle>{editing ? "Edit purchase" : "New purchase"}</DialogTitle>
          <PurchaseForm
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
        title={confirm === "all" ? "Delete all purchases?" : "Delete selected purchases?"}
        body={
          confirm === "all"
            ? "Every purchase line goes. This cannot be undone."
            : `${selected.size} purchase line${selected.size === 1 ? "" : "s"} will be deleted.`
        }
        confirmLabel={confirm === "all" ? "Delete all" : "Delete selected"}
        pending={delMany.isPending || delAll.isPending}
        onClose={() => setConfirm(null)}
        onConfirm={() => {
          if (confirm === "all") delAll.mutate();
          else delMany.mutate([...selected]);
          setConfirm(null);
        }}
      />
    </div>
  );
}
