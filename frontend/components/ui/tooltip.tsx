"use client"

import * as React from "react"
import { cn } from "@/lib/utils"
import { Tooltip as TooltipPrimitive } from "radix-ui"
import './tooltip.css'

const TooltipLayout=React.createContext({compact:false,suppressed:false})

function TooltipProvider({
  delayDuration = 450,
  compact = false,
  suppressed = false,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>&{compact?:boolean;suppressed?:boolean}) {
  return (
    <TooltipLayout.Provider value={{compact,suppressed}}>
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      skipDelayDuration={160}
      disableHoverableContent
      {...props}
    />
    </TooltipLayout.Provider>
  )
}

function Tooltip({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />
}

function TooltipTrigger({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />
}

function TooltipContent({
  className,
  sideOffset = 7,
  collisionPadding = 12,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  const {compact,suppressed}=React.useContext(TooltipLayout)
  return (
    <TooltipPrimitive.Portal>
      <div className={compact?'compact-tip-layer':undefined}>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        data-window-tip={compact?'compact':'regular'}
        data-window-tip-suppressed={compact&&suppressed||undefined}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        sticky="always"
        className={cn(
          "z-50 w-fit origin-(--radix-tooltip-content-transform-origin) animate-in rounded-md bg-foreground px-3 py-1.5 text-xs text-balance text-background fade-in-0 zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
          className
        )}
        {...props}
      >
        {children}
        {!compact&&<TooltipPrimitive.Arrow width={8} height={4} className="tooltip-arrow fill-foreground" />}
      </TooltipPrimitive.Content>
      </div>
    </TooltipPrimitive.Portal>
  )
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
