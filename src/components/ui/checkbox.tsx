import { cn } from "@/lib/utils";

export function Checkbox({
  checked,
  onCheckedChange,
  label,
  className,
  indeterminate,
}: {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  label?: string;
  className?: string;
  indeterminate?: boolean;
}) {
  return (
    <label className={cn("inline-flex min-h-11 min-w-11 cursor-pointer items-center justify-center", className)}>
      <input
        type="checkbox"
        className="size-4 accent-primary"
        checked={checked}
        ref={(el) => {
          if (el) el.indeterminate = Boolean(indeterminate) && !checked;
        }}
        onChange={(e) => onCheckedChange(e.target.checked)}
        aria-label={label}
      />
    </label>
  );
}
