import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { beforeAll, describe, expect, it } from 'vitest'
import { initI18n } from '../../i18n'
import type { ProjectCardData } from './api'
import { ProjectCard } from './ProjectCard'

beforeAll(() => initI18n())

const project = (patch: Partial<ProjectCardData>): ProjectCardData =>
  ({
    id: 'p1',
    title: 'Tashkent City Mall',
    status: 'active',
    participantCount: 5000,
    contributors: [],
    image: null,
    ...patch,
  }) as ProjectCardData

function setup(p: ProjectCardData) {
  render(
    <MemoryRouter>
      <ProjectCard project={p} index={0} actions={['settings']} onAction={() => undefined} />
    </MemoryRouter>,
  )
}

describe('ProjectCard', () => {
  it('keeps the status caption and the title on a strip below the picture, not on it', () => {
    setup(project({ status: 'finished' }))
    const thumb = document.querySelector('.project-card-thumb')
    const body = document.querySelector('.project-card-body')
    expect(thumb?.textContent).toBe('')
    expect(thumb?.querySelector('*')).toBeNull()
    expect(body).toHaveTextContent('Tashkent City Mall')
    expect(body?.querySelector('.project-card-status')).toHaveTextContent('Завершён')
  })

  it('puts the actions button outside the picture, in the card, after the link', () => {
    setup(project({}))
    const menu = screen.getByRole('button', { name: /Tashkent City Mall/ })
    expect(menu.closest('.project-card-menu')).not.toBeNull()
    expect(menu.closest('.project-card-thumb')).toBeNull()
    expect(menu.closest('a')).toBeNull()
  })

  it('formats the participant count with a grouping space', () => {
    setup(project({}))
    expect(document.querySelector('.project-card-count')?.textContent).toMatch(/^5\s000 /)
  })
})
