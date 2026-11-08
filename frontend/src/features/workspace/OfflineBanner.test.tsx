import { screen } from '@testing-library/react'
import { beforeAll, describe, expect, it } from 'vitest'
import { initI18n } from '../../i18n'
import { renderWithProviders } from '../../test/render'
import { OfflineBanner } from './OfflineBanner'

beforeAll(async () => {
  await initI18n()
})

describe('OfflineBanner', () => {
  it('renders nothing while connected', () => {
    renderWithProviders(<OfflineBanner down={null} />)
    expect(screen.queryByText(/Нет связи/)).not.toBeInTheDocument()
  })

  it('explains that changes are kept when the connection is down', () => {
    renderWithProviders(<OfflineBanner down="offline" />)
    expect(screen.getByText(/Нет связи — изменения сохранятся автоматически/)).toBeInTheDocument()
  })

  it('uses its own wording while reconnecting', () => {
    renderWithProviders(<OfflineBanner down="reconnecting" />)
    expect(screen.getByText(/переподключаемся/)).toBeInTheDocument()
  })
})
