import { createContext, type ReactNode, useContext } from 'react'
import { type ProjectRealtime, useProjectRealtime } from './useProjectRealtime'

const RealtimeContext = createContext<ProjectRealtime | null>(null)

/** Connects the project WebSocket for the lifetime of the page and shares its state with the workspace. */
export function RealtimeProvider({ projectId, children }: { projectId: string; children: ReactNode }) {
  const value = useProjectRealtime(projectId)
  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>
}

/** Null outside a RealtimeProvider (tests, previews): consumers then behave as if nobody else were online. */
export function useRealtime(): ProjectRealtime | null {
  return useContext(RealtimeContext)
}
