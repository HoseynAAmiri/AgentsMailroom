"use client"

import type { ReactElement } from "react"
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip"
import { cn } from "cn"
import { useCanHover } from "@/hooks/use-mobile"

function TooltipProvider({
  delay = 0,
  ...props
}: TooltipPrimitive.Provider.Props) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delay={delay}
      {...props}
    />
  )
}

function Tooltip({ ...props }: TooltipPrimitive.Root.Props) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />
}

function TooltipTrigger({ ...props }: TooltipPrimitive.Trigger.Props) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />
}

function TooltipContent({
  className,
  side = "top",
  sideOffset = 7,
  align = "center",
  alignOffset = 0,
  children,
  ...props
}: TooltipPrimitive.Popup.Props &
  Pick<
    TooltipPrimitive.Positioner.Props,
    "align" | "alignOffset" | "side" | "sideOffset"
  >) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        positionMethod="fixed"
        collisionPadding={12}
        collisionAvoidance={{ side: "flip", align: "shift", fallbackAxisSide: "end" }}
        className="isolate z-[60] data-[anchor-hidden]:invisible"
      >
        <TooltipPrimitive.Popup
          data-slot="tooltip-content"
          className={cn(
            "block w-max max-w-[min(28rem,var(--available-width,100dvw),calc(100dvw_-_24px))] max-h-[min(var(--available-height,100dvh),calc(100dvh_-_24px))] overflow-y-auto rounded-md border border-border bg-popover px-3 py-1.5 text-xs leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere] text-popover-foreground shadow-lg",
            className
          )}
          {...props}
        >
          {children}
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  )
}

/** Base UI tooltip. On touch screens the trigger is left alone so the first tap still activates it. */
function HoverTip({
  label,
  side = "top",
  children,
}: {
  label: string
  side?: "top" | "right" | "bottom" | "left"
  children: ReactElement
}) {
  const canHover = useCanHover()
  if (!label || !canHover) return children
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent side={side}>{label}</TooltipContent>
    </Tooltip>
  )
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider, HoverTip }
