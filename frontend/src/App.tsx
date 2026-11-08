import { QueryClientProvider } from '@tanstack/react-query'
import { lazy, Suspense, useEffect, useState } from 'react'
import { BrowserRouter, Route, Routes, useNavigate } from 'react-router'
import { createQueryClient } from './api/queryClient'
import { AuthProvider } from './auth/AuthProvider'
import { onLogout } from './auth/events'
import { RequireAuth, RequirePerm } from './auth/guards'
import { Shell } from './components/Shell'
import { ToastProvider } from './components/Toast'
import { pages } from './routes'

// The print page is its own chunk and renders without the app shell (no topbar on paper).
const PrintPage = lazy(() => import('./pages/Print'))

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
        <AuthProvider>
          <BrowserRouter>
            <LogoutRedirect onLoggedOut={() => queryClient.clear()} />
            <Routes>
              <Route element={<Shell minimal />}>
                <Route path="/login" element={<pages.Login />} />
              </Route>
              <Route element={<RequireAuth />}>
                <Route
                  path="/projects/:id/print"
                  element={
                    <Suspense fallback={null}>
                      <PrintPage />
                    </Suspense>
                  }
                />
              </Route>
              <Route element={<Shell />}>
                <Route element={<RequireAuth />}>
                  <Route index element={<pages.Projects />} />
                  <Route path="/projects/:id" element={<pages.Workspace />} />
                  <Route path="/projects/:id/settings" element={<pages.ProjectSettings />} />
                  <Route path="/profile" element={<pages.Profile />} />
                  <Route element={<RequirePerm perm="user.view" />}>
                    <Route path="/admin/users" element={<pages.AdminUsers />} />
                  </Route>
                  <Route element={<RequirePerm perm="role.manage" />}>
                    <Route path="/admin/roles" element={<pages.AdminRoles />} />
                  </Route>
                  <Route element={<RequirePerm perm="system.view" />}>
                    <Route path="/admin/system" element={<pages.AdminSystem />} />
                  </Route>
                </Route>
                {/* The component gallery is a developer tool: not routed in production builds. */}
                {import.meta.env.DEV && (
                  <Route element={<RequirePerm perm="system.view" />}>
                    <Route path="/design" element={<pages.Design />} />
                  </Route>
                )}
                <Route path="*" element={<pages.NotFound />} />
              </Route>
            </Routes>
          </BrowserRouter>
        </AuthProvider>
      </ToastProvider>
    </QueryClientProvider>
  )
}
