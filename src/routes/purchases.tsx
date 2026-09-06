import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/purchases")({
  beforeLoad: () => {
    throw redirect({ to: "/books/purchases" });
  },
});
