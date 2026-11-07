import { QueryClientProvider } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { BrowserRouter, Route, Routes, useNavigate } from 'react-router'
import { createQueryClient } from './api/queryClient'
import { onLogout } from './auth/events'
import { Shell } from './components/Shell'
import { ToastProvider } from './components/Toast'
import { pages } from './routes'

/** Sends the user to /login whenever the API layer reports a lost session. */
function LogoutRedirect({ onLoggedOut }: { onLoggedOut: () => void }) {
  const navigate = useNavigate()
  useEffect(
    () =>
      onLogout(() => {
        onLoggedOut()
        void navigate('/login', { viewTransition: true })
      }),
    [navigate, onLoggedOut],
  )
  return null
}

export function App() {
  const [queryClient] = useState(createQueryClient)
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <BrowserRouter>
          <LogoutRedirect onLoggedOut={() => queryClient.clear()} />
          <Routes>
            <Route element={<Shell minimal />}>
              <Route path="/login" element={<pages.Login />} />
            </Route>
            <Route element={<Shell />}>
              <Route index element={<pages.Projects />} />
              <Route path="/projects/:id" element={<pages.Workspace />} />
              <Route path="/projects/:id/settings" element={<pages.ProjectSettings />} />
              <Route path="/profile" element={<pages.Profile />} />
              <Route path="/admin/users" element={<pages.AdminUsers />} />
              <Route path="/admin/roles" element={<pages.AdminRoles />} />
              <Route path="/admin/system" element={<pages.AdminSystem />} />
              <Route path="/design" element={<pages.Design />} />
              <Route path="*" element={<pages.NotFound />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </ToastProvider>
    </QueryClientProvider>
  )
}
