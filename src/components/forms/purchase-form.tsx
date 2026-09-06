import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { Purchase, PurchaseInput } from "@/lib/ledger/types";
import { useState } from "react";

const today = () => new Date().toISOString().slice(0, 10);

export function PurchaseForm({
  initial,
  onSubmit,
  onCancel,
  pending,
}: {
  initial?: Purchase | null;
  onSubmit: (data: PurchaseInput) => void;
  onCancel: () => void;
  pending?: boolean;
}) {
  const [itemType, setItemType] = useState(initial?.itemType ?? "live_fish");
  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        onSubmit({
          id: initial?.id,
          occurredOn: String(fd.get("occurredOn")),
          supplier: String(fd.get("supplier")),
          itemType,
          productName: String(fd.get("productName")),
          variety: String(fd.get("variety") || ""),
          quantity: Number(fd.get("quantity")),
          unitCost: Number(fd.get("unitCost")),
          shippingCost: Number(fd.get("shippingCost") || 0),
          mortalityCount: Number(fd.get("mortalityCount") || 0),
          notes: String(fd.get("notes") || ""),
        });
      }}
    >
      <Field label="Date">
        <Input name="occurredOn" type="date" required defaultValue={initial?.occurredOn ?? today()} />
      </Field>
      <Field label="Supplier / source">
        <Input name="supplier" required defaultValue={initial?.supplier} placeholder="Empire Discus — Hussein" />
      </Field>
      <Field label="Type">
        <Select value={itemType} onValueChange={(v) => setItemType(v as typeof itemType)}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="live_fish">Live fish</SelectItem>
            <SelectItem value="supplies">Supplies</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <Field label="Product">
        <Input name="productName" required defaultValue={initial?.productName} placeholder="Discus" />
      </Field>
      <Field label="Variety / strain">
        <Input name="variety" defaultValue={initial?.variety ?? ""} placeholder="Tiger Turquoise" />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Quantity">
          <Input name="quantity" type="number" step="0.001" min="0" required defaultValue={initial?.quantity ?? 1} />
        </Field>
        <Field label="Unit cost (₹)">
          <Input name="unitCost" type="number" step="0.01" min="0" required defaultValue={initial?.unitCost ?? ""} />
        </Field>
        <Field label="Shipping (₹)">
          <Input name="shippingCost" type="number" step="0.01" min="0" defaultValue={initial?.shippingCost ?? 0} />
        </Field>
        <Field label="Died on this buy">
          <Input name="mortalityCount" type="number" step="1" min="0" defaultValue={initial?.mortalityCount ?? 0} />
        </Field>
      </div>
      <Field label="Notes">
        <Input name="notes" defaultValue={initial?.notes ?? ""} placeholder="Optional" />
      </Field>
      <div className="mt-2 flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending}>
          {initial ? "Save changes" : "Add purchase"}
        </Button>
      </div>
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="grid gap-1.5">
      <Label>{label}</Label>
      {children}
    </label>
  );
}
