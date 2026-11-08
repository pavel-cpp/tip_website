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
    // The toolbar is rendered together with the tabs, so once it is there the layout mode is known.
    await this.page.getByRole('toolbar', { name: this.t('workspace.toolbar') }).waitFor()
    const tab = this.page.getByRole('tab', { name: this.t('workspace.panel.db') })
    if (await tab.isVisible()) await tab.click()
    await this.grid.waitFor()
  }

  async showPicture(): Promise<void> {
    await this.page.getByRole('toolbar', { name: this.t('workspace.toolbar') }).waitFor()
    const tab = this.page.getByRole('tab', { name: this.t('workspace.panel.picture') })
    if (await tab.isVisible()) await tab.click()
  }

  /** The spreadsheet grid, or the scrolling card list on phones. */
  get grid(): Locator {
    return this.page.locator('.pt-grid, .pc-scroll')
  }
  /** True when the phone layout (cards plus bottom sheet) is active. */
  async isCards(): Promise<boolean> {
    return (await this.page.locator('.pc-scroll').count()) > 0
  }
  get rows(): Locator {
    return this.grid.locator('[data-row-id]')
  }

  /** Phone: the bottom sheet that edits one row. */
  get sheet(): Locator {
    return this.page.locator('.sheet')
  }

  /** Selects one row: a click on its number cell, or a long press on its card. */
  async selectRow(row: Locator): Promise<void> {
    if (await this.isCards()) await this.longPress(row)
    else await this.cell(row, 'number').click()
  }

  /** Deletes the current selection through the toolbar button (table) or the bulk bar (cards). */
  async deleteSelected(count: number): Promise<void> {
    if (await this.isCards()) {
      await this.bulkBar.getByRole('button', { name: this.t('workspace.bulk.delete', { count }) }).click()
    } else {
      await this.button('workspace.deleteSelected', { count }).click()
    }
  }
  /** Phone: the bar of bulk actions shown in selection mode. */
  get bulkBar(): Locator {
    return this.page.getByRole('toolbar', { name: this.t('workspace.bulk.label') })
  }

  /** Phone: press and hold a card until selection mode starts (a real hold, so it needs real time). */
  async longPress(card: Locator): Promise<void> {
    await card.scrollIntoViewIfNeeded()
    const box = await card.boundingBox()
    if (!box) throw new Error('card is not visible')
    await this.page.mouse.move(box.x + box.width / 2, box.y + 24)
    await this.page.mouse.down()
    await expect(this.bulkBar).toBeHidden()
    await this.page.waitForTimeout(650)
    await this.page.mouse.up()
    await expect(this.bulkBar).toBeVisible()
  }

  /** Selects every row and presses Print, on either layout. */
  async selectAllAndPrint(): Promise<void> {
    if (await this.isCards()) {
      await this.page.getByRole('button', { name: this.t('workspace.select.enter') }).click()
      await this.page.getByRole('checkbox', { name: this.t('workspace.select.all') }).check()
      await this.bulkBar.getByRole('button', { name: /^(Печать|Chop etish)/ }).click()
      return
    }
    await this.grid.getByRole('checkbox', { name: this.t('workspace.selectVisible') }).check()
    await this.button('workspace.print').click()
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
    if (await this.isCards()) {
      // Phones edit in the bottom sheet: tap the card, change the field, save.
      await row.locator('.pc-main').click()
      await this.sheet
        .getByLabel(this.t(col === 'name' ? 'workspace.col.name' : 'workspace.col.phone'))
        .fill(value)
      await this.sheet.getByRole('button', { name: this.t('workspace.sheet.save') }).click()
      await expect(this.sheet).toBeHidden()
      return
    }
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
      // Firefox ignores clipboardData in the ClipboardEvent constructor, so attach it to a plain event.
      const event = new Event('paste', { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'clipboardData', { value: dt })
      el.dispatchEvent(event)
    }, text)
  }

  async ready(): Promise<void> {
    await settle(this.page)
  }
}
