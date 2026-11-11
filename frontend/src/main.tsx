import './styles/fonts.css'
import './styles/tokens.css'
import './styles/base.css'
import './styles/ui.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { initI18n } from './i18n'
import { initMotionSetting } from './lib/motion'
import { installRouteMotion } from './lib/routeMotion'
import { initTheme } from './theme/theme'

initTheme()
initMotionSetting()
// Before the router exists, so the popstate hook runs ahead of the router's own listener.
installRouteMotion()

// The dictionary for the stored language is loaded first so the first paint is already localised.
void initI18n().then(() => {
  const root = document.getElementById('root')
  if (!root) throw new Error('missing #root')
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
})
