// Ko-fi's cup-with-heart mark, drawn inline. Ko-fi's own widget loads a
// script and an image from Ko-fi's CDN; the panel's Content-Security-Policy
// blocks both, and third-party script has no place inside an admin panel.
// The cup gets a navy outline, as on Ko-fi's own button art: white alone is
// only about 2.5:1 on Ko-fi's blue, too faint for the icon-only rail.
export function KofiCup({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" focusable="false">
      <path
        fill="#fff"
        stroke="#0f2340"
        strokeWidth={1.5}
        strokeLinejoin="round"
        d="M4 5h13a1 1 0 0 1 1 1v1h.5A3.5 3.5 0 0 1 22 10.5v1a3.5 3.5 0 0 1-3.5 3.5h-.8a6.5 6.5 0 0 1-6.2 5h-2A6.5 6.5 0 0 1 3 13.5V6a1 1 0 0 1 1-1Zm14 4v4h.5a1.5 1.5 0 0 0 1.5-1.5v-1A1.5 1.5 0 0 0 18.5 9H18Z"
      />
      <path
        fill="#FF5E5B"
        d="M10.5 10c-.55-.75-1.8-.9-2.45-.2-.65.7-.5 1.75.15 2.4l2.3 2.3 2.3-2.3c.65-.65.8-1.7.15-2.4-.65-.7-1.9-.55-2.45.2Z"
      />
    </svg>
  )
}
