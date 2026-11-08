import type { SVGProps } from 'react'

// Workspace-only icons on the same 24x24 stroke grid as components/Icon (kept here to avoid editing the shared set).
const paths = {
  print: (
    <>
      <path d="M7 9V3h10v6" />
      <rect x="4" y="9" width="16" height="8" rx="2" />
      <path d="M7 14h10v7H7z" />
    </>
  ),
  copy: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V6a2 2 0 012-2h9" />
    </>
  ),
  // Save ticket: the picture frame with a download arrow, so it cannot be mistaken for import.
  save: (
    <>
      <path d="M13 20H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v6" />
      <circle cx="8.500" cy="9.500" r="1.500" />
      <path d="M3 17l5-5 4 4M18 14v7M15 18l3 3 3-3" />
    </>
  ),
  // Import: a sheet with an arrow pointing into it.
  upload: (
    <>
      <path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z" />
      <path d="M14 3v5h5M12 11v6M9 14l3 3 3-3" />
    </>
  ),
  // Export: a spreadsheet grid with an arrow leaving it.
  exportTable: (
    <>
      <path d="M13 21H6a2 2 0 01-2-2V5a2 2 0 012-2h12a2 2 0 012 2v6" />
      <path d="M4 9h16M4 15h9M10 3v18M16 17h6M19 14l3 3-3 3" />
    </>
  ),
  image: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="9" cy="10" r="1.800" />
      <path d="M21 16l-5-5-8 8" />
    </>
  ),
  table: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 10h18M9 10v10" />
    </>
  ),
  chevronUp: <path d="M6 15l6-6 6 6" />,
  chevronDown: <path d="M6 9l6 6 6-6" />,
  // Selection mode: a checked box next to list lines.
  selectMode: (
    <>
      <rect x="3" y="4" width="6" height="6" rx="1.500" />
      <path d="M4.500 7l1.200 1.200L8 5.800M13 7h8M3 15h6v5H3zM13 17.500h8" />
    </>
  ),
  maximize: <path d="M5 9V5h4M19 9V5h-4M5 15v4h4M19 15v4h-4" />,
  restore: <path d="M9 5v4H5M15 5v4h4M9 19v-4H5M15 19v-4h4" />,
  zoomIn: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.500-3.500M8 11h6M11 8v6" />
    </>
  ),
  zoomOut: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.500-3.500M8 11h6" />
    </>
  ),
  file: (
    <>
      <path d="M6 3h8l5 5v13H6z" />
      <path d="M14 3v5h5" />
    </>
  ),
} as const

export type WsIconName = keyof typeof paths

export function WsIcon({
  name,
  size = 20,
  ...rest
}: { name: WsIconName; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {paths[name]}
    </svg>
  )
}
