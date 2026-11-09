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

type PullRequest = {
  url: string
  title: string
  body: string
  mergeCommit?: { oid: string } | null
  baseRefName?: string
  headRefName?: string
  state?: 'OPEN' | 'MERGED' | 'CLOSED'
}

type Run = { status: string; conclusion: string; event: string; createdAt: string; url: string }

type Issue = { url: string; description: string; state?: string; attachments?: readonly string[] }

type World = {
  branch: string | null
  linked?: readonly string[]
  branchPullRequest?: PullRequest
  pullRequests?: readonly PullRequest[]
  issues?: Readonly<Record<string, Issue>>
  linearCalls?: { count: number }
  compare?: Readonly<Record<string, string>>
  runs?: readonly Run[]
  now?: number
}

const ran = (exitCode: number, stdout: string) => ({
  value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

const linkRow = (url: string) =>
  `{"type":"pr-link","sessionId":"s1","prNumber":${url.split('/').pop()},"prUrl":"${url}","prRepository":"acme/app"}`

const start = async ($: Engine, on: On, world: World) => {
  const clock = mock.clock(on, world.now === undefined ? undefined : { now: world.now })

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

    if (args[0] === 'run') {
      return ran(0, JSON.stringify(world.runs ?? []))
    }

    if (args[0] === 'api') {
      const branch = String(args[1]).split('...').pop() ?? ''
      const status = world.compare?.[branch]

      return status === undefined ? ran(1, '') : ran(0, `${status}\n`)
    }

    const url = args.find(arg => arg.startsWith('https://'))
    const pullRequest =
      url === undefined
        ? world.branchPullRequest
        : world.pullRequests?.find(candidate => candidate.url === url)

    return pullRequest === undefined
      ? ran(1, '')
      : ran(
          0,
          JSON.stringify({
            number: Number(pullRequest.url.split('/').pop()),
            state: pullRequest.mergeCommit ? 'MERGED' : 'OPEN',
            headRefName: 'feature-branch',
            ...pullRequest,
          }),
        )
  })
  on('http.fetch', (_, e) => {
    if (world.linearCalls) {
      world.linearCalls.count += 1
    }

    const query = String(JSON.parse(String(e.init?.body ?? '{}')).query ?? '')
    const data = Object.fromEntries(
      [...query.matchAll(/(i\d+): issue\(id: "([^"]+)"\)/g)].map(([, alias, id]) => {
        const issue = world.issues?.[id ?? '']

        return [
          alias,
          issue
            ? {
                url: issue.url,
                description: issue.description,
                state: issue.state === undefined ? null : { name: issue.state },
                attachments: { nodes: (issue.attachments ?? []).map(url => ({ url })) },
              }
            : null,
        ]
      }),
    )

    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ data }) } }
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

test('adds the Figma frames the ticket links', { options: { linearApiKey: 'key' } }, async ($, on) => {
  await start($, on, {
    branch: null,
    linked: [`${REPO}/3268`],
    pullRequests: [{ url: `${REPO}/3268`, title: 'feat(payments): LIQ-5463: the Buy tab', body: '' }],
    issues: {
      'LIQ-5463': {
        url: 'https://linear.app/acme/issue/LIQ-5463/the-buy-tab',
        description: 'Design: [Buy](https://www.figma.com/design/abc/Buy?node-id=1-2)',
        attachments: ['https://www.figma.com/design/abc/Buy?node-id=3-4', 'https://github.com/acme/app/pull/3268'],
      },
    },
  })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })

    expect((await ui.find({ type: 'Link', text: /LIQ-5463$/ }))?.props.href).toBe(
      'https://linear.app/acme/issue/LIQ-5463/the-buy-tab',
    )
    expect((await ui.find({ type: 'Link', text: /Figma 1$/ }))?.props.href).toBe(
      'https://www.figma.com/design/abc/Buy?node-id=1-2',
    )
    expect((await ui.find({ type: 'Link', text: /Figma 2$/ }))?.props.href).toBe(
      'https://www.figma.com/design/abc/Buy?node-id=3-4',
    )
    await ui.unmount()
  }
})

test('names a lone frame Figma', { options: { linearApiKey: 'key' } }, async ($, on) => {
  await start($, on, {
    branch: 'liq-77-modal',
    issues: {
      'LIQ-77': { url: 'https://linear.app/acme/issue/LIQ-77/modal', description: 'https://www.figma.com/design/xyz/Modal' },
    },
  })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const figma = await ui.find({ type: 'Link', text: /Figma$/ })

  expect(figma?.children).toEqual(['Figma'])
  expect((await ui.find({ type: 'Link', text: /LIQ-77$/ }))?.props.href).toBe('https://linear.app/acme/issue/LIQ-77/modal')
  await ui.unmount()
})

test('asks Linear nothing without an API key', { options: { workspace: 'acme' } }, async ($, on) => {
  const linearCalls = { count: 0 }

  await start($, on, {
    branch: 'liq-77-modal',
    linearCalls,
    issues: { 'LIQ-77': { url: 'https://linear.app/acme/issue/LIQ-77/modal', description: 'https://www.figma.com/design/xyz/Modal' } },
  })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect(linearCalls.count).toBe(0)
  expect(await ui.find({ type: 'Link', text: /Figma/ })).toBeUndefined()
  await ui.unmount()
})

test('shows the ticket state from Linear', { options: { linearApiKey: 'key' } }, async ($, on) => {
  await start($, on, {
    branch: 'liq-77-modal',
    issues: { 'LIQ-77': { url: 'https://linear.app/acme/issue/LIQ-77/modal', description: '', state: 'In Review' } },
  })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect((await ui.find({ type: 'Text', text: /^ In Review$/ }))?.text).toBe(' In Review')
  await ui.unmount()
})

const MERGED = {
  url: `${REPO}/3270`,
  title: 'feat(wallet): LIQ-88: deposits',
  body: '',
  mergeCommit: { oid: 'abc123' },
  baseRefName: 'main',
}

test('shows how far the merged pull request has deployed', { options: { workspace: 'acme', stages: 'main=dev, qa=qa, prod=prod' } }, async ($, on) => {
  await start($, on, {
    branch: null,
    linked: [MERGED.url],
    pullRequests: [MERGED],
    compare: { qa: 'ahead', prod: 'diverged' },
  })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })

    expect((await ui.find({ type: 'Text', text: /^ · on qa$/ }))?.text).toBe(' · on qa')
    await ui.unmount()
  }
})

test('names prod once the merge commit reaches it', { options: { workspace: 'acme', stages: 'main=dev, qa=qa, prod=prod' } }, async ($, on) => {
  await start($, on, {
    branch: null,
    linked: [MERGED.url],
    pullRequests: [MERGED],
    compare: { qa: 'ahead', prod: 'identical' },
  })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect((await ui.find({ type: 'Text', text: /^ · on prod$/ }))?.text).toBe(' · on prod')
  await ui.unmount()
})

test('shows no stage when no stages are set', { options: { workspace: 'acme' } }, async ($, on) => {
  await start($, on, {
    branch: null,
    linked: [MERGED.url],
    pullRequests: [MERGED],
    compare: { qa: 'ahead', prod: 'ahead' },
  })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect(await ui.find({ type: 'Text', text: /· on / })).toBeUndefined()
  await ui.unmount()
})

test('shows no stage for an open pull request', { options: { workspace: 'acme', stages: 'main=dev, qa=qa, prod=prod' } }, async ($, on) => {
  await start($, on, {
    branch: null,
    linked: [MERGED.url],
    pullRequests: [{ ...MERGED, mergeCommit: null }],
    compare: { qa: 'ahead', prod: 'ahead' },
  })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect(await ui.find({ type: 'Link', text: /LIQ-88$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /· on / })).toBeUndefined()
  await ui.unmount()
})

const PREVIEW_OPTIONS = {
  workspace: 'acme',
  previewWorkflow: 'pr-preview.yml',
  previewLinks: 'Preview=https://pr-{number}.preview.acme.dev, Admin=https://pr-{number}.admin.preview.acme.dev',
}
const NOW = Date.parse('2026-11-09T12:00:00Z')
const OPEN = { url: `${REPO}/3268`, title: 'feat(payments): LIQ-5463: the Buy tab', body: '' }
const RUN = {
  status: 'completed',
  conclusion: 'success',
  event: 'workflow_dispatch',
  createdAt: '2026-11-09T11:00:00Z',
  url: 'https://github.com/acme/app/actions/runs/7',
}

test('links the preview of an open pull request', { options: PREVIEW_OPTIONS }, async ($, on) => {
  await start($, on, { branch: null, now: NOW, linked: [OPEN.url], pullRequests: [OPEN], runs: [RUN] })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })

    expect((await ui.find({ type: 'Link', text: /Preview$/ }))?.props.href).toBe('https://pr-3268.preview.acme.dev')
    expect((await ui.find({ type: 'Link', text: /Admin$/ }))?.props.href).toBe('https://pr-3268.admin.preview.acme.dev')
    await ui.unmount()
  }
})

test('says the preview is deploying while its run is going', { options: PREVIEW_OPTIONS }, async ($, on) => {
  await start($, on, {
    branch: null,
    now: NOW,
    linked: [OPEN.url],
    pullRequests: [OPEN],
    runs: [{ ...RUN, status: 'in_progress', conclusion: '' }],
  })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const deploying = await ui.find({ type: 'Link', text: /Preview deploying$/ })

  expect(deploying?.props.href).toBe(RUN.url)
  expect(await ui.find({ type: 'Link', text: /Admin$/ })).toBeUndefined()
  await ui.unmount()
})

test('links the failed run when the preview did not deploy', { options: PREVIEW_OPTIONS }, async ($, on) => {
  await start($, on, {
    branch: null,
    now: NOW,
    linked: [OPEN.url],
    pullRequests: [OPEN],
    runs: [{ ...RUN, conclusion: 'failure' }],
  })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect((await ui.find({ type: 'Link', text: /Preview failed$/ }))?.props.href).toBe(RUN.url)
  await ui.unmount()
})

test('drops a preview older than its lifetime, or torn down', { options: PREVIEW_OPTIONS }, async ($, on) => {
  await start($, on, {
    branch: null,
    now: NOW,
    linked: [OPEN.url],
    pullRequests: [OPEN],
    runs: [{ ...RUN, createdAt: '2026-11-07T10:00:00Z' }],
  })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect(await ui.find({ type: 'Link', text: /Preview/ })).toBeUndefined()
  expect(await ui.find({ type: 'Link', text: /LIQ-5463$/ })).toBeDefined()
  await ui.unmount()
})

test('shows no preview for a merged pull request', { options: PREVIEW_OPTIONS }, async ($, on) => {
  await start($, on, { branch: null, now: NOW, linked: [MERGED.url], pullRequests: [MERGED], runs: [RUN] })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect(await ui.find({ type: 'Link', text: /Preview/ })).toBeUndefined()
  await ui.unmount()
})

test('shows no preview once the newest run is the teardown', { options: PREVIEW_OPTIONS }, async ($, on) => {
  await start($, on, {
    branch: null,
    now: NOW,
    linked: [OPEN.url],
    pullRequests: [OPEN],
    runs: [{ ...RUN, event: 'pull_request' }],
  })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect(await ui.find({ type: 'Link', text: /Preview/ })).toBeUndefined()
  await ui.unmount()
})
