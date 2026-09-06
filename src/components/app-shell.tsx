import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { signOut } from "@/lib/auth/client";
import { DenMark } from "@/components/den-mark";
import { cn } from "@/lib/utils";
import { Link, useRouterState } from "@tanstack/react-router";
import { ArrowDownLeft, ArrowUpRight, LayoutDashboard, Package } from "lucide-react";
import type { ReactNode } from "react";

const NAV = [
  { to: "/books", label: "Overview", icon: LayoutDashboard },
  { to: "/books/stock", label: "Stock", icon: Package },
  { to: "/books/purchases", label: "Purchases", icon: ArrowDownLeft },
  { to: "/books/sales", label: "Sales", icon: ArrowUpRight },
] as const;

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { user, isPending } = useCurrentUserState();

  return (
    <div className="min-h-svh bg-background text-foreground">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-56 flex-col border-r border-border bg-sidebar px-4 py-6 md:flex">
        <Brand />
        <nav className="mt-10 flex flex-col gap-1">
          {NAV.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className={cn(
                "flex h-11 items-center gap-3 rounded-xl px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
                (pathname === item.to ||
                  (item.to === "/books" && (pathname === "/books" || pathname === "/books/"))) &&
                  "bg-muted text-primary",
              )}
            >
              <item.icon className="size-4" />
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="mt-auto">
          {isPending ? (
            <div className="h-10 w-full animate-pulse rounded-xl bg-muted" />
          ) : (
            user && <AccountChip name={user.displayName ?? user.primaryEmail ?? "Account"} />
          )}
        </div>
      </aside>

      <header className="sticky top-0 z-20 flex items-center justify-between border-b border-border bg-background/90 px-4 py-3 backdrop-blur md:hidden">
        <Brand compact />
        {isPending ? (
          <div className="size-8 animate-pulse rounded-full bg-muted" />
        ) : (
          user && <AccountChip name={user.displayName ?? user.primaryEmail ?? "Account"} compact />
        )}
      </header>

      <main className="px-4 pb-24 pt-6 md:ml-56 md:px-8 md:pb-10">{children}</main>

      <nav className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-4 border-t border-border bg-sidebar/95 px-2 py-2 backdrop-blur md:hidden">
        {NAV.map((item) => (
          <Link
            key={item.to}
            to={item.to}
            className={cn(
              "flex min-h-11 flex-col items-center justify-center gap-1 rounded-lg text-[11px] font-medium text-muted-foreground",
              (pathname === item.to ||
                (item.to === "/books" && (pathname === "/books" || pathname === "/books/"))) &&
                "text-primary",
            )}
          >
            <item.icon className="size-4" />
            {item.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}

function AccountChip({ name, compact }: { name: string; compact?: boolean }) {
  return (
    <div className={cn("flex items-center gap-2", compact && "max-w-[50%]")}>
      <span className="truncate text-xs text-muted-foreground">{name}</span>
      <button
        type="button"
        className="h-9 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
        onClick={() => signOut()}
      >
        Out
      </button>
    </div>
  );
}

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <DenMark className="size-8 shrink-0" />
      <div className={cn(compact && "leading-tight")}>
        <p className="font-display text-base leading-none tracking-tight">The Discus Den</p>
        <p className="mt-1 max-w-[11rem] text-[9px] leading-tight tracking-[0.14em] text-primary uppercase">
          A Legacy of Elite Aquatics
        </p>
      </div>
    </div>
  );
}
