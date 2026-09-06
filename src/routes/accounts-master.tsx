import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/accounts-master")({
  beforeLoad: () => {
    throw redirect({ to: "/books/stock" });
  },
});
