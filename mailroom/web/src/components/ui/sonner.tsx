"use client"

import { useTheme } from "next-themes"
import { Toaster as Sonner, type ToasterProps } from "sonner"
import { CircleCheckIcon, InfoIcon, TriangleAlertIcon, OctagonXIcon, Loader2Icon } from "lucide-react"
import { useIsMobile } from "@/hooks/use-mobile"

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme()
  const phone = useIsMobile()

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      position={phone ? "top-center" : "top-right"}
      offset={{ top: "max(16px, env(safe-area-inset-top))", right: "max(16px, env(safe-area-inset-right))" }}
      mobileOffset={{ top: "max(12px, env(safe-area-inset-top))", left: 12, right: 12 }}
      className="toaster group pointer-events-none"
      icons={{
        success: (
          <CircleCheckIcon className="size-4" />
        ),
        info: (
          <InfoIcon className="size-4" />
        ),
        warning: (
          <TriangleAlertIcon className="size-4" />
        ),
        error: (
          <OctagonXIcon className="size-4" />
        ),
        loading: (
          <Loader2Icon className="size-4 animate-spin" />
        ),
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: "cn-toast",
          closeButton: "pointer-events-auto",
          actionButton: "pointer-events-auto",
          cancelButton: "pointer-events-auto",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
