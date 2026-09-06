import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { Toaster } from "sonner";

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { staleTime: 10_000, retry: 1 } },
      }),
  );
  return (
    <QueryClientProvider client={client}>
      {children}
      <Toaster
        theme="dark"
        position="bottom-center"
        toastOptions={{
          className: "border-border bg-card text-foreground",
        }}
      />
    </QueryClientProvider>
  );
}
