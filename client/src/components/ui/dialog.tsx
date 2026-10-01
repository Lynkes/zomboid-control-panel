import * as React from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { X } from "lucide-react"

import { cn } from "@/lib/utils"

const Dialog = DialogPrimitive.Root

const DialogTrigger = DialogPrimitive.Trigger

const DialogPortal = DialogPrimitive.Portal

const DialogClose = DialogPrimitive.Close

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "fixed inset-0 z-50 bg-black/80 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className
    )}
    {...props}
  />
))
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      // RTL sweep (2026-09-04): left-[50%]/translate-x-[-50%] and the
      // matching slide keyframes are deliberately left physical -- this
      // centers the dialog on the viewport (50% from either edge is the
      // same point), so there's no start/end asymmetry to get backwards.
      //
      // Viewport bound (2026-09 community report, Edit Server dialog): a
      // fixed, translate-centered box with no height limit runs off the top
      // AND bottom of a short or zoomed-in window at once, and scrolling the
      // page can't bring a fixed box into view (Radix locks page scroll
      // anyway) -- a tall dialog's own Save/Cancel were simply unreachable.
      // Call sites used to opt in one at a time with max-h-[85vh]
      // overflow-y-auto, leaving every other dialog one zoom step or one
      // extra field away from the same bug, so the bound now lives here.
      // dvh (not vh) is the viewport a phone actually shows with its
      // toolbars; Vite's build target (baseline-widely-available) supports
      // it everywhere, and a call site's own max-h-* still replaces it via
      // tailwind-merge. A popup that must reach past the dialog's box
      // belongs in ui/popover.tsx, which portals it out of this scroll box
      // (ItemPicker and VehiclePicker do); overflow-visible still opts a
      // dialog out, but no dialog needs it now.
      //
      // The has-[...] pair fires only when a <DialogBody> is a direct
      // child: the dialog becomes a flex column so that body alone shrinks
      // and scrolls while the header and footer buttons stay on screen.
      // Every other dialog keeps the grid it was built and measured against
      // -- a grid row never shrinks to honor max-height (checked in
      // Chromium), so those scroll as a whole instead, which is also what a
      // DialogBody dialog degrades to in a browser without :has().
      //
      // grid-cols-[minmax(0,1fr)] (2026-09 community report, Templates
      // preview: "doesn't appear in full"): without a column template the
      // grid has one implicit `auto` column, and an auto track can never be
      // narrower than the widest min-content inside it -- a truncate/nowrap
      // line, a <pre>, a long path or mod list with no break point. That
      // content widened the column past w-full/max-w-*, overflow-y-auto
      // turned overflow-x to auto too, and the whole dialog scrolled
      // sideways with its title and buttons (truncate never truncated). A
      // 0 minimum keeps the one column at the dialog's width, so such
      // content truncates, wraps or scrolls inside itself instead. The flex
      // mode above ignores it, and a call site's own grid-cols-* replaces it.
      className={cn(
        "fixed left-[50%] top-[50%] z-50 grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 border bg-background p-6 shadow-lg duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%] sm:rounded-lg",
        "grid-cols-[minmax(0,1fr)] max-h-[calc(100dvh-2rem)] overflow-y-auto has-[>[data-dialog-body]]:flex has-[>[data-dialog-body]]:flex-col",
        className
      )}
      {...props}
    >
      {children}
      <DialogPrimitive.Close className="absolute end-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground">
        <X className="h-4 w-4" />
        <span className="sr-only">Close</span>
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPortal>
))
DialogContent.displayName = DialogPrimitive.Content.displayName

const DialogHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    // pe-8 keeps a long, wrapping title out from under the absolute close
    // button (end-4 top-4, plus its focus ring) that every DialogContent draws.
    className={cn(
      "flex flex-col space-y-1.5 pe-8 text-center sm:text-start",
      className
    )}
    {...props}
  />
)
DialogHeader.displayName = "DialogHeader"

// The scrolling middle of a long dialog: place it between DialogHeader and
// DialogFooter, as a direct child of DialogContent (see the has-[...] note
// there). -mx-6/px-6 stretch the scrollport into DialogContent's default
// p-6 so the scrollbar sits at the dialog's edge and focus rings at the
// field edges aren't clipped. border-y rules it off from the pinned header
// and footer (DESIGN.md's border-border/40 divider): once it scrolls, a
// field's muted helper text slides up flush under the equally muted
// DialogDescription and otherwise reads as part of it, and with overlay
// scrollbars (macOS, GTK) a field cut off at a rule is the only sign there
// is more. -my-1/py-3 put each rule midway between the header or footer
// and the nearest field (12px either side, out of DialogContent's 16px gap)
// and leave the first and last rows' focus rings room inside the
// scrollport. A dialog that changes DialogContent's padding must match it
// here.
const DialogBody = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    data-dialog-body=""
    className={cn("-mx-6 -my-1 min-h-0 overflow-y-auto border-y border-border/40 px-6 py-3", className)}
    {...props}
  />
)
DialogBody.displayName = "DialogBody"

const DialogFooter = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2",
      className
    )}
    {...props}
  />
)
DialogFooter.displayName = "DialogFooter"

// [overflow-wrap:anywhere] on the title and description: both routinely
// interpolate user data (a server, file, preset, template or player name, a
// ban reason with a URL in it) that can be one long unbroken token. Tailwind's
// break-words (overflow-wrap: break-word) would wrap it too, but doesn't
// lower the text's min-content width, so in a flex row (an icon + title) it
// still pushes the row past the dialog; `anywhere` does both. Text that fits
// renders exactly as before.
const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn(
      "text-lg font-semibold leading-none tracking-tight [overflow-wrap:anywhere]",
      className
    )}
    {...props}
  />
))
DialogTitle.displayName = DialogPrimitive.Title.displayName

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-sm text-muted-foreground [overflow-wrap:anywhere]", className)}
    {...props}
  />
))
DialogDescription.displayName = DialogPrimitive.Description.displayName

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogTrigger,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogBody,
  DialogFooter,
  DialogTitle,
  DialogDescription,
}
