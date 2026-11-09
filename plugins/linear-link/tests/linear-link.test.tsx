import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

const BAND = {
  plugin: 'linear-link',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

const SURFACES = ['terminal', 'desktop'] as const

type World = {
  branch: string | null
  pullRequest: { title: string; body: string } | null
}

const ran = (exitCode: number, stdout: string) => ({
  value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

const start = async ($: Engine, on: On, world: World) => {
  const clock = mock.clock(on)

  on('process.run', (_, e) => {
    if (e.argv[0] === 'git') {
      return world.branch === null ? ran(128, '') : ran(0, `${world.branch}\n`)
    }

    return world.pullRequest === null ? ran(1, '') : ran(0, JSON.stringify(world.pullRequest))
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })

  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await clock.advance(1)
}

test('links the ticket a pull request title names to the URL its body carries', async ($, on) => {
  await start($, on, {
    branch: 'liq-5895-pinned-strip',
    pullRequest: {
      title: 'fix(sportsbook): LIQ-5895: the pinned strip fills its corners',
      body: 'Fixes [LIQ-5895](https://linear.app/acme/issue/LIQ-5895/strip-corners), see [LIQ-1](https://linear.app/acme/issue/LIQ-1)',
    },
  })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    const link = await ui.find({ type: 'Link' })

    expect(link?.props.href).toBe('https://linear.app/acme/issue/LIQ-5895/strip-corners')
    expect(link?.children).toEqual(['LIQ-5895'])
    await ui.unmount()
  }
})

test('lists every ticket a title names', { options: { workspace: 'acme' } }, async ($, on) => {
  await start($, on, {
    branch: 'cleanup',
    pullRequest: { title: 'refactor(app): LIQ-12, LIQ-345: clean up code', body: '' },
  })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const first = await ui.find({ type: 'Link', text: /LIQ-12$/ })
  const second = await ui.find({ type: 'Link', text: /LIQ-345$/ })

  expect(first?.props.href).toBe('https://linear.app/acme/issue/LIQ-12')
  expect(second?.props.href).toBe('https://linear.app/acme/issue/LIQ-345')
  await ui.unmount()
})

test('takes the ticket from the branch before a pull request exists', { options: { workspace: 'acme' } }, async ($, on) => {
  await start($, on, { branch: 'rob/liq-42-weekly-report', pullRequest: null })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect((await ui.find({ type: 'Link' }))?.props.href).toBe('https://linear.app/acme/issue/LIQ-42')
  await ui.unmount()
})

test('shows the ticket as plain text when no workspace is known', async ($, on) => {
  await start($, on, { branch: 'liq-7-thing', pullRequest: null })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect(await ui.find({ type: 'Link' })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /^LIQ-7$/ }))?.text).toBe('LIQ-7')
  await ui.unmount()
})

test('draws nothing without a ticket', { options: { workspace: 'acme' } }, async ($, on) => {
  await start($, on, {
    branch: 'main',
    pullRequest: { title: 'feat: add UTF-8 support to SHA-256 checks', body: '' },
  })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect(await ui.find({ type: 'Link' })).toBeUndefined()
  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
  await ui.unmount()
})

test('yields the band to a survey', { options: { workspace: 'acme' } }, async ($, on) => {
  await start($, on, { branch: 'liq-9-thing', pullRequest: null })

  const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, hasSurvey: true }, surface: 'desktop' })

  expect(await ui.find({ type: 'Link' })).toBeUndefined()
  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
  await ui.unmount()
})
