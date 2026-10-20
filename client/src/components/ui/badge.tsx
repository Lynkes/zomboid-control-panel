"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: 'default' | 'secondary' | 'destructive' | 'outline' | 'success' | 'warning'
}

function Badge({ className, variant = 'default', ...props }: BadgeProps) {
  const variants = {
    // Opacity steps must be on Tailwind's scale (5, 10, 15, ...): an
    // off-scale one like /12 compiles to nothing, which left these untinted.
    default: "border border-primary/20 bg-primary/10 text-primary",
    secondary: "border border-border/70 bg-secondary/70 text-secondary-foreground",
    destructive: "border border-destructive/25 bg-destructive/10 text-destructive",
    outline: "border border-input bg-transparent text-foreground",
    success: "border border-[hsl(var(--success)/0.28)] bg-[hsl(var(--success)/0.12)] text-[hsl(var(--success))]",
    // Tinted like success/destructive: a solid amber fill read as a button.
    warning: "border border-warning/40 bg-warning/10 text-warning"
  }

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
        variants[variant],
        className
      )}
      data-badge-variant={variant}
      {...props}
    />
  )
}

export { Badge }
