// Runs before first paint so the page never flashes the wrong theme.
// It is a separate file because the server's Content-Security-Policy forbids inline scripts.
// Logic mirrors src/theme/theme.ts (storage key, colours) and src/lib/motion.ts.
;(() => {
  let mode = 'dark'
  let reduce = false
  try {
    const stored = localStorage.getItem('tip.theme')
    if (stored === 'dark' || stored === 'light' || stored === 'system') mode = stored
    reduce = localStorage.getItem('tip.reduceMotion') === '1'
  } catch {
    // Storage can be blocked (private mode); the defaults apply.
  }
  const light =
    mode === 'light' ||
    (mode === 'system' && window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches)
  const theme = light ? 'light' : 'dark'
  const root = document.documentElement
  root.setAttribute('data-theme', theme)
  root.style.colorScheme = theme
  if (reduce) root.setAttribute('data-reduce-motion', 'true')
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', light ? '#f4f5f8' : '#131418')
})()
