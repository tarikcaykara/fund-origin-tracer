"use client";

import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react";
import type { CSSProperties } from "react";
import { Toaster as Sonner, type ToasterProps } from "sonner";
import { useTheme } from "@/theme.tsx";

const Toaster = ({ ...props }: ToasterProps) => {
  const { resolved } = useTheme();

  return (
    <Sonner
      {...props}
      theme={resolved}
      position="bottom-right"
      duration={4000}
      richColors
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--foreground)",
          "--normal-text": "var(--background)",
          "--normal-border": "transparent",
          "--success-bg": "var(--foreground)",
          "--success-border": "transparent",
          "--success-text": "var(--background)",
          "--info-bg": "var(--foreground)",
          "--info-border": "transparent",
          "--info-text": "var(--background)",
          "--warning-bg": "var(--foreground)",
          "--warning-border": "transparent",
          "--warning-text": "var(--background)",
          "--error-bg": "var(--destructive-muted)",
          "--error-text": "var(--destructive-muted-foreground)",
          "--error-border": "var(--destructive-border)",
          "--border-radius": "var(--radius-md)",
        } as CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: "cn-toast border-0 bg-foreground text-background shadow-popover",
          error:
            "cn-toast-error border border-destructive-border bg-destructive-muted text-destructive-muted-foreground",
        },
      }}
    />
  );
};

export { Toaster };
