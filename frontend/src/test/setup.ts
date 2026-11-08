import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'

// jsdom has no matchMedia. A plain function (not vi.fn) so tests can vi.spyOn it and get it restored.
if (typeof window.matchMedia !== 'function') {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    }) as MediaQueryList
}

// The workspace opens a project WebSocket. Page tests must not hit the network: this inert socket never
// connects, so the page behaves as if the server were unreachable. Realtime tests install their own fake.
class InertWebSocket {
  readyState = 0
  onopen = null
  onmessage = null
  onclose = null
  onerror = null
  send() {}
  close() {}
}
vi.stubGlobal('WebSocket', InertWebSocket)

afterEach(() => {
  cleanup()
  localStorage.clear()
  document.documentElement.removeAttribute('data-reduce-motion')
})
