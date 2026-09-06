import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/sales")({
  beforeLoad: () => {
    throw redirect({ to: "/books/sales" });
  },
});
