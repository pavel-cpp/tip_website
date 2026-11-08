import type { Locator, Page } from '@playwright/test'
import { expect } from '@playwright/test'
import { type Locale, settle, tr } from './pages'

/** Page object for the project workspace (picture panel + participants table). */
export class WorkspacePage {
  readonly t: ReturnType<typeof tr>

  constructor(
    readonly page: Page,
    locale: Locale = 'ru',
  ) {
    this.t = tr(locale)
  }

  async open(projectId: string): Promise<void> {
    await this.page.goto(`/projects/${projectId}`)
    await this.showTable()
  }

  /** On phones the panels are tabs; make sure the table is the visible one. */
  async showTable(): Promise<void> {
    const tab = this.page.getByRole('tab', { name: this.t('workspace.panel.db') })
    if (await tab.isVisible().catch(() => false)) await tab.click()
    await this.grid.waitFor()
  }

  async showPicture(): Promise<void> {
    const tab = this.page.getByRole('tab', { name: this.t('workspace.panel.picture') })
    if (await tab.isVisible().catch(() => false)) await tab.click()
  }

  get grid(): Locator {
    return this.page.getByRole('grid', { name: this.t('workspace.table.label') })
  }
  get rows(): Locator {
    return this.grid.locator('[data-row-id]')
  }
  get search(): Locator {
    return this.page.getByRole('searchbox', { name: this.t('workspace.search.label') })
  }
  button(key: Parameters<ReturnType<typeof tr>>[0], params: Record<string, string | number> = {}): Locator {
    return this.page.getByRole('button', { name: this.t(key, params) })
  }

  row(index: number): Locator {
    return this.rows.nth(index)
  }

  cell(row: Locator, col: 'number' | 'name' | 'phone'): Locator {
    return row.locator(`[data-col-name="${col}"]`)
  }

  rowByText(text: string): Locator {
    return this.rows.filter({ hasText: text })
  }

  /** Edits a cell the way a keyboard user does: select it, Enter, type, Enter. */
  async editCell(row: Locator, col: 'name' | 'phone', value: string): Promise<void> {
    // The row is re-resolved by id: once editing starts its text is no longer in the DOM text content.
    const id = await row.getAttribute('data-row-id')
    const same = this.grid.locator(`[data-row-id="${id}"]`)
    await this.cell(same, col).click()
    await this.page.keyboard.press('Enter')
    const input = same.locator('input.pt-input')
    await input.fill(value)
    await this.page.keyboard.press('Enter')
    await expect(input).toHaveCount(0)
  }

  async addRows(count: number): Promise<void> {
    await this.button('workspace.addRows').click()
    const dialog = this.page.getByRole('dialog', { name: this.t('workspace.add.title') })
    await dialog.getByLabel(this.t('workspace.add.count')).fill(String(count))
    await dialog.getByRole('button', { name: this.t('workspace.add.submit') }).click()
    await expect(dialog).toBeHidden()
  }

  /** Dispatches a text/plain paste on the grid, as the browser does for Ctrl+V of spreadsheet cells. */
  async paste(text: string): Promise<void> {
    await this.grid.focus()
    await this.grid.evaluate((el, data) => {
      const dt = new DataTransfer()
      dt.setData('text/plain', data)
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    }, text)
  }

  async ready(): Promise<void> {
    await settle(this.page)
  }
}
