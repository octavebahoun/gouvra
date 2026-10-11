import { act, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { AnimatedOutlet } from "./app-shell";

describe("route outlet", () => {
  it("shows the next page at once, without waiting for the previous one to leave", async () => {
    const router = createMemoryRouter(
      [
        {
          path: "/w/:slug",
          element: <AnimatedOutlet />,
          children: [
            { path: "agents", element: <h1>Agents</h1> },
            { path: "executions/:id", element: <h1>Execution</h1> },
          ],
        },
      ],
      { initialEntries: ["/w/acme/agents"] },
    );
    render(<RouterProvider router={router} />);
    expect(screen.getByRole("heading", { name: "Agents" })).toBeInTheDocument();
    await act(() => router.navigate("/w/acme/executions/1"));
    expect(screen.getByRole("heading", { name: "Execution" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Agents" })).not.toBeInTheDocument();
  });
});
