import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError } from "@/lib/api/errors";
import { cn } from "@/lib/cn";
import { StatusBadge } from "./badge";
import { Button } from "./button";
import { Field, Input } from "./field";
import { ErrorState } from "./states";

describe("design system", () => {
  it("merges conflicting utilities, last one wins", () => {
    expect(cn("px-2 text-sm", "px-4")).toBe("text-sm px-4");
  });

  it("status badges always carry a text label", () => {
    render(<StatusBadge status="timed_out" />);
    expect(screen.getByText("Timed out")).toBeInTheDocument();
  });

  it("loading buttons are busy, disabled and ignore clicks", async () => {
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Launch
      </Button>,
    );
    const button = screen.getByRole("button", { name: /launch/i });
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toBeDisabled();
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("fields link their error to the control", () => {
    render(
      <Field label="E-mail" error="Enter a valid e-mail address." required>
        <Input />
      </Field>,
    );
    const input = screen.getByLabelText(/e-mail/i);
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAttribute("aria-required", "true");
    const describedBy = input.getAttribute("aria-describedby") ?? "";
    expect(document.getElementById(describedBy)).toHaveTextContent("Enter a valid e-mail address.");
  });

  it("error states show the diagnostic ID and never raw internals", () => {
    render(
      <ErrorState
        error={new ApiError({ status: 500, code: "internal_error", request_id: "req-123" })}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("req-123");
  });

  it("403 errors render the access-denied state", () => {
    render(<ErrorState error={new ApiError({ status: 403, code: "forbidden" })} />);
    expect(screen.getByText("You don't have access to this")).toBeInTheDocument();
  });
});
