import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Spinner } from "./spinner";

export const buttonVariants = cva(
  [
    "relative inline-flex shrink-0 items-center justify-center gap-2 rounded-field font-medium whitespace-nowrap select-none",
    "transition-[background-color,border-color,color,box-shadow,transform] duration-150 ease-standard",
    "active:scale-[0.97] disabled:pointer-events-none disabled:opacity-55 aria-busy:cursor-progress",
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0",
  ],
  {
    variants: {
      variant: {
        primary: "bg-brand text-on-solid shadow-sm hover:bg-brand-hover",
        secondary:
          "border border-line-strong/60 bg-surface text-ink shadow-sm hover:border-line-strong hover:bg-surface-2",
        tertiary: "text-ink hover:bg-surface-2",
        danger: "bg-danger-solid text-on-solid shadow-sm hover:bg-danger-solid-hover",
        "danger-ghost": "text-danger-text hover:bg-danger-soft",
        link: "h-auto p-0 text-brand-text underline-offset-4 hover:underline active:scale-100",
      },
      size: {
        sm: "h-8 px-3 text-[13px] max-md:h-10 [&_svg]:size-3.5",
        md: "h-9 px-4 text-sm max-md:h-10 [&_svg]:size-4",
        lg: "h-11 px-5 text-[15px] [&_svg]:size-4.5",
        icon: "size-9 max-md:size-10 [&_svg]:size-4",
        "icon-sm": "size-8 max-md:size-10 [&_svg]:size-4",
      },
    },
    // Links stay inline whatever the size: no box height or padding.
    compoundVariants: [{ variant: "link", class: "h-auto px-0 py-0 max-md:h-auto" }],
    defaultVariants: { variant: "primary", size: "md" },
  },
);

export type ButtonProps = ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
    loading?: boolean;
    /** Accessible text announced while loading (defaults to the children). */
    loadingText?: string;
    leftIcon?: ReactNode;
    rightIcon?: ReactNode;
  };

export function Button({
  className,
  variant,
  size,
  asChild = false,
  loading = false,
  loadingText,
  leftIcon,
  rightIcon,
  disabled,
  children,
  onClick,
  type,
  ...props
}: ButtonProps) {
  const classes = cn(buttonVariants({ variant, size }), className);
  if (asChild) {
    // Slot merges our props onto the single child (e.g. a router <Link>), icons included.
    return (
      <Slot.Root data-slot="button" className={classes} {...props}>
        {leftIcon}
        <Slot.Slottable>{children}</Slot.Slottable>
        {rightIcon}
      </Slot.Root>
    );
  }
  return (
    <button
      data-slot="button"
      className={classes}
      disabled={(disabled ?? false) || loading}
      aria-busy={loading || undefined}
      type={type ?? "button"}
      onClick={loading ? (event) => event.preventDefault() : onClick}
      {...props}
    >
      {loading ? <Spinner className="size-4" label={loadingText} /> : leftIcon}
      {children}
      {!loading && rightIcon}
    </button>
  );
}

export type IconButtonProps = Omit<ButtonProps, "children" | "leftIcon" | "rightIcon"> & {
  /** Required accessible name: icon-only buttons must be labelled. */
  label: string;
  icon: ReactNode;
};

export function IconButton({
  label,
  icon,
  size = "icon",
  variant = "tertiary",
  ...props
}: IconButtonProps) {
  return (
    <Button aria-label={label} title={label} size={size} variant={variant} {...props}>
      {icon}
    </Button>
  );
}
