// Glyphs checked against nickustinov/even-g2-notes docs/display.md (read 2026-11-24):
//   supported:   U+00B7 middle dot, U+25B2 black up-pointing triangle, U+25CF black circle, U+2501 and U+2500 box lines
//   unsupported: U+2713 check mark (Dingbats block is absent) -> a supported "●" is used instead
//   not stated:  U+2026 horizontal ellipsis -> three ASCII dots "..." are used
//   not listed:  U+2212 minus sign -> ASCII "-" is used
// Characters outside the firmware font are skipped silently, so keep this list short and ASCII-leaning.
export const DOT = '·'
export const UP = '▲'
export const CHECK = '●'
export const ELLIPSIS = '...'
export const BAR_FULL = '━'
export const BAR_EMPTY = '─'
