import { RedirectToSignIn } from "@/lib/auth/gates";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import type { ReactNode } from "react";

export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, isPending } = useCurrentUserState();
  if (isPending) {
    return (
      <div className="grid min-h-svh place-items-center bg-background">
        <div className="h-24 w-48 animate-pulse rounded-2xl bg-muted" />
      </div>
    );
  }
  if (!user) return <RedirectToSignIn />;
  return <>{children}</>;
}
