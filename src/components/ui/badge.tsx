import { cn } from "@/lib/utils";

export function Badge({
  className,
  tone = "muted",
  ...props
}: React.ComponentProps<"span"> & { tone?: "muted" | "fish" | "supplies" | "ok" | "warn" }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-medium tracking-wide",
        tone === "muted" && "bg-muted text-muted-foreground",
        tone === "fish" && "bg-accent/15 text-accent",
        tone === "supplies" && "bg-secondary text-secondary-foreground",
        tone === "ok" && "bg-ok/15 text-ok",
        tone === "warn" && "bg-destructive/15 text-destructive",
        className,
      )}
      {...props}
    />
  );
}
