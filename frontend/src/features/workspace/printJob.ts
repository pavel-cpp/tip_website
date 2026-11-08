// The workspace hands the participant ids to the dedicated print page (/projects/:id/print). Thousands
// of ids do not fit in a URL, so they travel through module state, mirrored to sessionStorage so a
// reload of the print page keeps working.
const KEY = 'tip.printJob'

export interface PrintJob {
  projectId: string
  ids: string[]
}

let current: PrintJob | null = null

export function setPrintJob(job: PrintJob): void {
  current = job
  try {
    sessionStorage.setItem(KEY, JSON.stringify(job))
  } catch {
    // The in-memory copy is enough for the normal flow.
  }
}

export function getPrintJob(projectId: string): PrintJob | null {
  if (!current) {
    try {
      const raw = sessionStorage.getItem(KEY)
      if (raw) current = JSON.parse(raw) as PrintJob
    } catch {
      current = null
    }
  }
  return current && current.projectId === projectId && current.ids.length > 0 ? current : null
}

export function clearPrintJob(): void {
  current = null
  try {
    sessionStorage.removeItem(KEY)
  } catch {
    // Nothing to clean up.
  }
}
