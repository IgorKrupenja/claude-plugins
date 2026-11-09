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
const TRANSCRIPT = '/home/me/.claude/projects/-repo/s1.jsonl'
const REPO = 'https://github.com/acme/app/pull'

type PullRequest = { url: string; title: string; body: string }

type World = {
  branch: string | null
  linked?: readonly string[]
  branchPullRequest?: PullRequest
  pullRequests?: readonly PullRequest[]
}

const ran = (exitCode: number, stdout: string) => ({
  value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

const linkRow = (url: string) =>
  `{"type":"pr-link","sessionId":"s1","prNumber":${url.split('/').pop()},"prUrl":"${url}","prRepository":"acme/app"}`

const start = async ($: Engine, on: On, world: World) => {
  const clock = mock.clock(on)

  mock.env(on, { HOME: '/home/me' })
  on('session.id', () => ({ value: 's1' }))

  on('process.run', (_, e) => {
    const [command, ...args] = e.argv

    if (command === 'git') {
      return world.branch === null ? ran(128, '') : ran(0, `${world.branch}\n`)
    }

    if (command === 'find') {
      return ran(0, `${TRANSCRIPT}\n`)
    }

    if (command === 'grep') {
      const rows = (world.linked ?? []).map(linkRow)

      return rows.length === 0 ? ran(1, '') : ran(0, `${rows.join('\n')}\n`)
    }

    const url = args.find(arg => arg.startsWith('https://'))
    const pullRequest =
      url === undefined
        ? world.branchPullRequest
        : world.pullRequests?.find(candidate => candidate.url === url)

    return pullRequest === undefined ? ran(1, '') : ran(0, JSON.stringify(pullRequest))
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })

  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await clock.advance(1)
}

test('links the ticket of the pull request the session is bound to', async ($, on) => {
  await start($, on, {
    branch: null,
    linked: [`${REPO}/3268`, `${REPO}/3268`],
    pullRequests: [
      {
        url: `${REPO}/3268`,
        title: 'feat(payments): LIQ-5463: the Buy tab lists every onramp',
        body: 'Implements [LIQ-5463](https://linear.app/acme/issue/LIQ-5463/buy-tab), after [LIQ-5383](https://linear.app/acme/issue/LIQ-5383)',
      },
    ],
  })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    const link = await ui.find({ type: 'Link' })

    expect(link?.props.href).toBe('https://linear.app/acme/issue/LIQ-5463/buy-tab')
    expect(link?.children).toEqual(['LIQ-5463'])
    expect(await ui.find({ type: 'Link', text: /LIQ-5383$/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('lists the tickets of every bound pull request that names one', { options: { workspace: 'acme' } }, async ($, on) => {
  await start($, on, {
    branch: 'main',
    linked: [`${REPO}/3488`, `${REPO}/3545`],
    pullRequests: [
      { url: `${REPO}/3488`, title: 'feat(player-frontend): LIQ-5702: start a new deposit', body: '' },
      { url: `${REPO}/3545`, title: 'Promote main to qa', body: '' },
    ],
  })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect((await ui.find({ type: 'Link' }))?.props.href).toBe('https://linear.app/acme/issue/LIQ-5702')
  expect(await ui.find({ type: 'Text', text: /Promote/ })).toBeUndefined()
  await ui.unmount()
})

test('reads the current branch pull request when the session has none bound', { options: { workspace: 'acme' } }, async ($, on) => {
  await start($, on, {
    branch: 'cleanup',
    branchPullRequest: { url: `${REPO}/12`, title: 'refactor(app): LIQ-12, LIQ-345: clean up code', body: '' },
  })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect((await ui.find({ type: 'Link', text: /LIQ-12$/ }))?.props.href).toBe('https://linear.app/acme/issue/LIQ-12')
  expect((await ui.find({ type: 'Link', text: /LIQ-345$/ }))?.props.href).toBe('https://linear.app/acme/issue/LIQ-345')
  await ui.unmount()
})

test('takes the ticket from the branch before a pull request exists', { options: { workspace: 'acme' } }, async ($, on) => {
  await start($, on, { branch: 'rob/liq-42-weekly-report' })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect((await ui.find({ type: 'Link' }))?.props.href).toBe('https://linear.app/acme/issue/LIQ-42')
  await ui.unmount()
})

test('shows the ticket as plain text when no workspace is known', async ($, on) => {
  await start($, on, { branch: 'liq-7-thing' })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect(await ui.find({ type: 'Link' })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /^LIQ-7$/ }))?.text).toBe('LIQ-7')
  await ui.unmount()
})

test('draws nothing without a ticket', { options: { workspace: 'acme' } }, async ($, on) => {
  await start($, on, {
    branch: 'main',
    branchPullRequest: { url: `${REPO}/1`, title: 'feat: add UTF-8 support to SHA-256 checks', body: '' },
  })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect(await ui.find({ type: 'Link' })).toBeUndefined()
  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
  await ui.unmount()
})

test('yields the band to a survey', { options: { workspace: 'acme' } }, async ($, on) => {
  await start($, on, { branch: 'liq-9-thing' })

  const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, hasSurvey: true }, surface: 'desktop' })

  expect(await ui.find({ type: 'Link' })).toBeUndefined()
  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
  await ui.unmount()
})
