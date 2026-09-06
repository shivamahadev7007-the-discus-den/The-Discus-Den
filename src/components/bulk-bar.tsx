import { Button } from "@/components/ui/button";
import { CheckSquare, Trash2 } from "lucide-react";

export function BulkBar({
  total,
  selected,
  onSelectAll,
  onClear,
  onDeleteSelected,
  onDeleteAll,
  noun,
}: {
  total: number;
  selected: number;
  onSelectAll: () => void;
  onClear: () => void;
  onDeleteSelected: () => void;
  onDeleteAll: () => void;
  noun: string;
}) {
  if (total === 0) return null;
  const allOn = selected === total;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button type="button" size="sm" variant="outline" onClick={allOn ? onClear : onSelectAll}>
        <CheckSquare />
        {allOn ? "Clear" : "Select all"}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={selected === 0}
        onClick={onDeleteSelected}
      >
        <Trash2 />
        Delete selected{selected ? ` (${selected})` : ""}
      </Button>
      <Button type="button" size="sm" variant="destructive" onClick={onDeleteAll}>
        <Trash2 />
        Delete all {noun}
      </Button>
    </div>
  );
}
