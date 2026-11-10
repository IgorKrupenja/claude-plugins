import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

const URL = 'https://github.com/acme/app/pull/3268'
const START = Date.parse('2026-11-09T12:00:00Z')
const MERGE_SHA = 'mergesha1'
const APP = '/home/me/.claude/plugins/data/session-banners-igor-plugins/Claude Notify.app'
const WATCHING = { watchPullRequests: true, stages: 'main=dev, qa=qa, prod=prod', bannerApp: APP }

type PullRequestState = Record<string, unknown>

type World = {
  states: readonly PullRequestState[]
  runs?: Readonly<Record<string, readonly string[]>>
}

const ran = (exitCode: number, stdout: string) => ({
  value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

const open = (extra: PullRequestState = {}): PullRequestState => ({
  state: 'OPEN',
  headRefOid: 'head-a',
  author: { login: 'igor' },
  reviewDecision: 'REVIEW_REQUIRED',
  mergeStateStatus: 'BLOCKED',
  autoMergeRequest: { enabledAt: '2026-11-09T11:00:00Z' },
  mergeQueueEntry: null,
  reviews: { nodes: [] },
  ...extra,
})

const merged = (mergedAt: string): PullRequestState => ({
  ...open(),
  state: 'MERGED',
  mergedAt,
  mergeCommit: { oid: MERGE_SHA },
})

const start = async ($: Engine, on: On, world: World) => {
  const clock = mock.clock(on, { now: START })
  const session = mock.session(on)
  const banners: string[][] = []
  const submitted: string[] = []
  let graphqlCalls = 0

  mock.env(on, { HOME: '/home/me', CLAUDE_CODE_HOST_SESSION_ID: 'local_abc' })
  on('fs.exists', (_, e) => ({ value: e.path === APP }))
  on('fs.read', () => ({ value: JSON.stringify({ title: 'Buy tab' }) }))
  on('session.id', () => ({ value: 's1' }))
  on('process.run', (_, e) => {
    const [command, ...args] = e.argv
    const joined = args.join(' ')

    if (command === 'git') {
      return ran(128, '')
    }

    if (command === 'find' && joined.includes('claude-code-sessions')) {
      return ran(0, '/home/me/Library/Application Support/Claude/claude-code-sessions/a/b/local_abc.json\n')
    }

    if (command === 'find') {
      return ran(0, '/home/me/.claude/projects/-repo/s1.jsonl\n')
    }

    if (command === 'open') {
      banners.push([...args])

      return ran(0, '')
    }

    if (command === 'grep') {
      return joined.includes('pr-link')
        ? ran(0, `{"type":"pr-link","sessionId":"s1","prNumber":3268,"prUrl":"${URL}","prRepository":"acme/app"}\n`)
        : ran(1, '')
    }

    if (args[0] === 'pr' && args[1] === 'view') {
      return ran(
        0,
        JSON.stringify({ url: URL, number: 3268, state: 'OPEN', title: 'feat(app): LIQ-1: a thing', body: '', headRefName: 'feature' }),
      )
    }

    if (args[0] === 'run') {
      return ran(0, '[]')
    }

    if (args[0] === 'api' && args[1] === 'graphql') {
      const state = world.states[Math.min(graphqlCalls, world.states.length - 1)]

      graphqlCalls += 1

      return ran(0, JSON.stringify({ data: { repository: { pullRequest: state } } }))
    }

    if (args[0] === 'api' && args[1] === '--paginate') {
      const branch = /branch=([^&]+)/.exec(joined)?.[1] ?? ''

      return ran(0, `${(world.runs?.[branch] ?? []).join('\n')}\n`)
    }

    if (args[0] === 'api' && joined.includes('/compare/')) {
      return ran(0, 'identical\n')
    }

    return ran(1, '')
  })
  on('prompt.submit', (_, e) => {
    submitted.push(e.text)

    return { text: e.text }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await clock.advance(1)

  const tick = async () => clock.advance(60_000)
  const notes = () =>
    session
      .appended()
      .filter(row => row.message.type === 'system')
      .map(row =>
        row.message.content.map(block => ('text' in block ? String(block.text) : '')).join(''),
      )

  return { notes, banners, session, submitted, tick, graphqlCalls: () => graphqlCalls }
}

test('posts an approval from someone else once', { options: WATCHING }, async ($, on) => {
  const approved = open({
    reviews: {
      nodes: [
        { author: { login: 'igor' }, submittedAt: '2026-11-09T12:01:20Z' },
        { author: { login: 'karen' }, submittedAt: '2026-11-09T12:01:30Z' },
      ],
    },
  })
  const { notes, banners, submitted, tick } = await start($, on, { states: [open(), approved] })

  await tick()
  await tick()
  await tick()

  expect(notes()).toEqual(['PR #3268 approved by karen at 12:01 UTC'])
  expect(submitted).toEqual([])
  expect(banners).toHaveLength(1)
  expect(banners[0]?.slice(0, 4)).toEqual(['-n', '-g', APP, '--args'])
  expect(banners[0]?.slice(4, 9)).toEqual([
    'Buy tab',
    'PR #3268 approved by karen',
    'Glass',
    'com.anthropic.claudefordesktop',
    'claude://claude.ai/epitaxy/local_abc',
  ])
  expect(banners[0]?.[9]).toBe(`claude://claude.ai/epitaxy/local_abc#${URL}#approved-2026-11-09T12:01:30Z`)
})

test('posts the merge, then each deploy as it lands', { options: WATCHING }, async ($, on) => {
  const { notes, tick } = await start($, on, {
    states: [open(), merged('2026-11-09T12:01:40Z')],
    runs: {
      main: [
        `2026-11-09T12:01:50Z 1 ${MERGE_SHA} completed success 2026-11-09T12:02:30Z https://github.com/acme/app/actions/runs/1`,
      ],
      qa: [],
    },
  })

  await tick()
  await tick()
  await tick()
  await tick()

  expect(notes()).toEqual([
    'PR #3268 merged at 12:01 UTC',
    'PR #3268 deployed to dev at 12:02 UTC: https://github.com/acme/app/actions/runs/1',
  ])
})

test('posts a failed deploy only once no retry is running', { options: WATCHING }, async ($, on) => {
  const { notes, tick } = await start($, on, {
    states: [open(), merged('2026-11-09T12:01:40Z')],
    runs: {
      main: [
        `2026-11-09T12:01:50Z 1 ${MERGE_SHA} completed failure 2026-11-09T12:02:30Z https://github.com/acme/app/actions/runs/1`,
      ],
    },
  })

  await tick()
  await tick()
  await tick()

  expect(notes().at(-1)).toBe(
    'PR #3268 deploy to dev failed at 12:02 UTC: https://github.com/acme/app/actions/runs/1',
  )
})

test('posts ready to merge for a new head with auto-merge off', { options: WATCHING }, async ($, on) => {
  const ready = { reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN', autoMergeRequest: null }
  const { notes, tick } = await start($, on, {
    states: [open(ready), open(ready), open({ ...ready, headRefOid: 'head-b0123456789' })],
  })

  await tick()
  await tick()
  await tick()

  expect(notes()).toEqual([
    'PR #3268 ready to merge at 12:03 UTC on head-b012: approved, checks green, auto-merge off',
  ])
})

test('posts a pull request leaving the merge queue', { options: WATCHING }, async ($, on) => {
  const { notes, tick } = await start($, on, {
    states: [open({ mergeQueueEntry: { state: 'QUEUED' } }), open(), open()],
  })

  await tick()
  await tick()
  await tick()

  expect(notes()).toEqual(['PR #3268 left the merge queue without merging at 12:03 UTC'])
})

test('watches nothing unless switched on', async ($, on) => {
  const { notes, banners, tick, graphqlCalls } = await start($, on, { states: [open()] })

  await tick()
  await tick()

  expect(graphqlCalls()).toBe(0)
  expect(notes()).toEqual([])
  expect(banners).toEqual([])
})

test('leaves Claude a note it reads only when asked to', { options: { ...WATCHING, tellClaude: true } }, async ($, on) => {
  const { session, tick } = await start($, on, { states: [open(), merged('2026-11-09T12:01:40Z')] })

  await tick()
  await tick()

  const forClaude = session
    .appended()
    .filter(row => row.message.type === 'user')
    .map(row => row.message.content.map(block => ('text' in block ? String(block.text) : '')).join(''))

  expect(forClaude).toEqual(['PR watch (status-bar): PR #3268 merged at 12:01 UTC'])
})

test('skips the banner when the helper app is missing', { options: { ...WATCHING, bannerApp: '/nowhere/Claude Notify.app' } }, async ($, on) => {
  const { notes, banners, tick } = await start($, on, { states: [open(), merged('2026-11-09T12:01:40Z')] })

  await tick()
  await tick()

  expect(notes()).toEqual(['PR #3268 merged at 12:01 UTC'])
  expect(banners).toEqual([])
})
