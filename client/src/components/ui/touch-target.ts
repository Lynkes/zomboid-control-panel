// Touch hit area for controls that have to stay smaller than the 44px
// comfortable touch target: the Switch pill and the Checkbox box. index.css
// stretches bare <button>s to 44x44 on coarse-pointer (touch) devices, which
// turned these into big circles and squares, so that rule now skips
// [role="switch"] and [role="checkbox"]. They get this instead: an invisible
// ::before, centred on the control and at least 44x44, that takes the taps.
// It's absolutely positioned, so the control's layout footprint doesn't
// change. The control itself must be `relative`.
export const COARSE_POINTER_HIT_AREA =
  "[@media(pointer:coarse)]:before:absolute [@media(pointer:coarse)]:before:left-1/2 [@media(pointer:coarse)]:before:top-1/2 [@media(pointer:coarse)]:before:h-full [@media(pointer:coarse)]:before:w-full [@media(pointer:coarse)]:before:min-h-11 [@media(pointer:coarse)]:before:min-w-11 [@media(pointer:coarse)]:before:-translate-x-1/2 [@media(pointer:coarse)]:before:-translate-y-1/2"
