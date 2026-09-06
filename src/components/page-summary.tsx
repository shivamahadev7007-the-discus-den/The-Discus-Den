export function PageSummary({ items }: { items: { label: string; value: string }[] }) {
  return (
    <p className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-sm">
      {items.map((item) => (
        <span key={item.label} className="inline-flex items-baseline gap-1.5">
          <span className="text-[11px] tracking-wide text-muted-foreground uppercase">{item.label}</span>
          <span className="tabular-nums text-foreground">{item.value}</span>
        </span>
      ))}
    </p>
  );
}
