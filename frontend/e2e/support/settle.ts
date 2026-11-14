import type { Locator } from '@playwright/test'

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

/**
 * The bounding box of an element once it has stopped moving. Pages ease things into place (cards are revealed,
 * panels glide to a new size), so a box read at the first moment is a frame of that motion and a mouse action
 * aimed at it misses. Playwright's own actions wait for this; raw `page.mouse` coordinates must do the same.
 */
export async function settledBox(locator: Locator, timeoutMs = 3000): Promise<Box> {
  const deadline = Date.now() + timeoutMs
  let prev = JSON.stringify(await locator.boundingBox())
  while (Date.now() < deadline) {
    await locator.page().waitForTimeout(60)
    const cur = JSON.stringify(await locator.boundingBox())
    if (cur === prev && cur !== 'null') return JSON.parse(cur) as Box
    prev = cur
  }
  throw new Error('the element never came to rest')
}
