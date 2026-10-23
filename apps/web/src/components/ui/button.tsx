import { cva, type VariantProps } from "class-variance-authority";
import { LoaderCircle } from "lucide-react";
import { Slot } from "radix-ui";
import type * as React from "react";
import { cn } from "@/lib/utils.ts";

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md border border-transparent bg-clip-padding type-body font-medium whitespace-nowrap transition-colors duration-[var(--duration-fast)] outline-none select-none max-md:min-h-11 disabled:pointer-events-none disabled:bg-border-strong disabled:text-muted-foreground disabled:opacity-100 aria-invalid:border-destructive aria-invalid:bg-destructive-muted aria-invalid:text-destructive-muted-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:opacity-[.86]",
        outline: "border-border-strong bg-card text-foreground hover:bg-muted",
        secondary: "border-border bg-secondary text-secondary-foreground hover:bg-muted",
        ghost: "hover:bg-muted hover:text-foreground",
        destructive: "bg-destructive text-destructive-foreground hover:opacity-[.86]",
        "destructive-outline":
          "border-destructive-border bg-transparent text-destructive hover:bg-destructive-muted",
        link: "text-link underline-offset-2 hover:underline",
      },
      size: {
        default: "h-8.5 px-3",
        xs: "h-6 gap-1 px-2 text-xs [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7.5 gap-1 px-2.5",
        lg: "h-9.5 gap-1.5 px-3.5",
        icon: "size-8.5 p-0",
        "icon-xs": "size-6 p-0 [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-7.5 p-0",
        "icon-lg": "size-9.5 p-0",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  loading = false,
  disabled,
  children,
  "aria-busy": ariaBusy,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
    loading?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : "button";
  const content =
    loading && !asChild ? (
      <>
        <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
        {children}
      </>
    ) : (
      children
    );

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      aria-busy={loading || ariaBusy}
      className={cn(buttonVariants({ variant, size, className }))}
      disabled={disabled || loading}
      {...props}
    >
      {content}
    </Comp>
  );
}

export { Button, buttonVariants };
