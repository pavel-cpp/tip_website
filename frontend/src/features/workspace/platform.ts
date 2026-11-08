/** True on iPhone, iPad (including iPadOS, which reports itself as a Mac) and iPod. */
export function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false
  if (/iPhone|iPad|iPod/.test(navigator.userAgent)) return true
  return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1
}

/** Apple platforms use Cmd for shortcuts, everything else Ctrl (docs/06-frontend.md, section 5, row 5). */
export function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return false
  return isIOS() || /Mac/.test(navigator.platform || navigator.userAgent)
}

export function copyShortcutLabel(): string {
  return isApplePlatform() ? 'Cmd' : 'Ctrl'
}

/** The platform "command" modifier of a keyboard or mouse event. */
export function hasCommandKey(e: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return isApplePlatform() ? e.metaKey : e.ctrlKey
}
