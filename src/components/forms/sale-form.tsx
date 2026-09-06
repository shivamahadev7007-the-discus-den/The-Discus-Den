import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { Sale, SaleInput } from "@/lib/ledger/types";
import { useState } from "react";

const today = () => new Date().toISOString().slice(0, 10);

export function SaleForm({
  initial,
  onSubmit,
  onCancel,
  pending,
}: {
  initial?: Sale | null;
  onSubmit: (data: SaleInput) => void;
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
          customerName: String(fd.get("customerName")),
          itemType,
          productName: String(fd.get("productName")),
          variety: String(fd.get("variety") || ""),
          quantity: Number(fd.get("quantity")),
          unitCost: Number(fd.get("unitCost")),
          unitPrice: Number(fd.get("unitPrice")),
          notes: String(fd.get("notes") || ""),
        });
      }}
    >
      <Field label="Date">
        <Input name="occurredOn" type="date" required defaultValue={initial?.occurredOn ?? today()} />
      </Field>
      <Field label="Customer">
        <Input name="customerName" required defaultValue={initial?.customerName} placeholder="Dr. Rasheed" />
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
        <Input name="variety" defaultValue={initial?.variety ?? ""} placeholder="Albino Platinum" />
      </Field>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Qty">
          <Input name="quantity" type="number" step="0.001" min="0" required defaultValue={initial?.quantity ?? 1} />
        </Field>
        <Field label="Cost (₹)">
          <Input name="unitCost" type="number" step="0.01" min="0" required defaultValue={initial?.unitCost ?? ""} />
        </Field>
        <Field label="Sell (₹)">
          <Input name="unitPrice" type="number" step="0.01" min="0" required defaultValue={initial?.unitPrice ?? ""} />
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
          {initial ? "Save changes" : "Add sale"}
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
