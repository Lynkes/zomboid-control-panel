import { forwardRef, useMemo } from 'react'

interface EditorGutterProps {
  lineCount: number
}

// Line numbers beside the editor (spec §A14.3): one <pre>, scrolled in step
// with the textarea by FileEditorDialog through the forwarded ref. Its font,
// size, line height and vertical padding must match the textarea's exactly,
// or the numbers drift away from their lines. Hidden below `sm`, and while
// lines wrap (a wrapped line would take two rows and put every number after
// it on the wrong line).
export const EditorGutter = forwardRef<HTMLPreElement, EditorGutterProps>(({ lineCount }, ref) => {
  const numbers = useMemo(() => {
    const count = Math.max(1, lineCount)
    let out = ''
    for (let line = 1; line <= count; line++) out += line === count ? String(line) : `${line}\n`
    return out
  }, [lineCount])

  return (
    <pre
      ref={ref}
      aria-hidden="true"
      dir="ltr"
      className="hidden select-none overflow-hidden border-e border-border/60 bg-muted/30 px-3 py-3 text-end font-mono text-[13px] leading-5 text-muted-foreground/70 sm:block"
    >
      {numbers}
    </pre>
  )
})
EditorGutter.displayName = 'EditorGutter'
