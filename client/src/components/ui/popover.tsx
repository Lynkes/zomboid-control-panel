import * as React from "react"
import * as PopoverPrimitive from "@radix-ui/react-popover"

import { cn } from "@/lib/utils"

const Popover = PopoverPrimitive.Root

const PopoverTrigger = PopoverPrimitive.Trigger

const PopoverAnchor = PopoverPrimitive.Anchor

// A popup that always fits the visible window (2026-09 community report:
// World Map > Custom item drop's item picker ran off the bottom of the
// window). The picker was portaled into its Dialog and positioned by hand;
// DialogContent is a transformed scroll box, so it was the containing block
// and the clip for that panel: the part past the dialog was cut off, and
// scrolling the dialog moved the panel away from its field.
//
// This content goes to document.body instead. Radix's popper places it with
// position: fixed against the real viewport, opens it on the requested side
// unless it doesn't fit there and the other side has more room, shifts it
// back inside horizontally (8px collision padding) and publishes the room
// left on the chosen side as --radix-popover-content-available-height/-width,
// which bound the box below. A tall consumer sets its own height (h-*) and
// scrolls its own regions inside; max-h still wins, so it never runs past
// the window. avoidCollisions is not a prop here: a popup that may leave the
// viewport is the bug this file exists to prevent.
//
// Inside a Dialog, pass modal to Popover: the Dialog's scroll lock only lets
// the wheel scroll the dialog's own DOM, and a modal popover takes the lock
// over for itself (plus focus trap and outside-click handling in its layer).
const PopoverContent = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Content>,
  Omit<React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>, "avoidCollisions">
>(({ className, align = "start", sideOffset = 4, collisionPadding = 8, ...props }, ref) => (
  <PopoverPrimitive.Portal>
    <PopoverPrimitive.Content
      ref={ref}
      align={align}
      sideOffset={sideOffset}
      collisionPadding={collisionPadding}
      {...props}
      avoidCollisions
      className={cn(
        "z-50 overflow-y-auto rounded-lg border border-border bg-popover text-popover-foreground shadow-xl shadow-black/30 outline-none",
        "max-h-[var(--radix-popover-content-available-height)] max-w-[var(--radix-popover-content-available-width)]",
        "origin-[var(--radix-popover-content-transform-origin)] motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-[0.98] motion-safe:duration-150 motion-safe:data-[side=bottom]:slide-in-from-top-1 motion-safe:data-[side=top]:slide-in-from-bottom-1",
        className
      )}
    />
  </PopoverPrimitive.Portal>
))
PopoverContent.displayName = PopoverPrimitive.Content.displayName

export { Popover, PopoverTrigger, PopoverAnchor, PopoverContent }
