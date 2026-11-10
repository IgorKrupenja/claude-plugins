import type { EngineInterface, Register } from 'claude-code'

import { watchPullRequests } from './watch'
import type { WatchEvent, WatchStage } from './watch'

const PR_LINK_ROW = /^\{"type":"pr-link".*"prUrl":"(https:\/\/github\.com\/[^"]+\/pull\/\d+)"/
const LINKED_PULL_REQUESTS = 3
const BRANCH_RECHECK_MS = 5 * 60_000
const WATCH_EVERY_MS = 60_000
const CLAUDE_BUNDLE_ID = 'com.anthropic.claudefordesktop'

const check = {
  stages: [] as WatchStage[],
  deployWorkflow: '',
  bannerApp: '',
  isTellingClaude: false,
  transcript: null as { sessionId: string; path: string | null } | null,
  branchPullRequest: null as { branch: string; url: string | null; checkedAt: number } | null,
  sessionTitle: null as { sessionId: string; title: string } | null,
  stopWatch: null as (() => void) | null,
  isRunning: false,
}

async function outputOf(
  $: EngineInterface,
  argv: readonly string[],
  timeoutMs: number,
): Promise<string | null> {
  try {
    const { exitCode, stdout } = await $.process.run(argv, { timeoutMs })

    return exitCode === 0 ? stdout : null
  } catch {
    return null
  }
}

async function transcriptOf($: EngineInterface): Promise<string | null> {
  const sessionId = await $.session.id()

  if (check.transcript?.sessionId === sessionId) {
    return check.transcript.path
  }

  const configDirectory = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${(await $.env.get('HOME')) ?? ''}/.claude`
  const found = await outputOf(
    $,
    ['find', `${configDirectory}/projects`, '-maxdepth', '2', '-name', `${sessionId}.jsonl`],
    10_000,
  )
  const path = found?.split('\n').find(line => line.endsWith('.jsonl')) ?? null

  check.transcript = { sessionId, path }

  return path
}

async function linkedPullRequestsOf($: EngineInterface): Promise<string[]> {
  const transcript = await transcriptOf($)

  if (transcript === null) {
    return []
  }

  const rows = await outputOf($, ['grep', '-E', '^\\{"type":"pr-link"', transcript], 10_000)
  const urls = (rows ?? '')
    .split('\n')
    .map(row => row.match(PR_LINK_ROW)?.[1])
    .filter((url): url is string => url !== undefined)

  return [...new Set(urls.reverse())].slice(0, LINKED_PULL_REQUESTS).reverse()
}

async function branchPullRequestOf($: EngineInterface, now: number): Promise<string | null> {
  const branch = (await outputOf($, ['git', 'branch', '--show-current'], 5_000))?.trim()

  if (!branch) {
    return null
  }

  const cached = check.branchPullRequest

  if (cached?.branch === branch && now - cached.checkedAt < BRANCH_RECHECK_MS) {
    return cached.url
  }

  const url = (await outputOf($, ['gh', 'pr', 'view', '--json', 'url', '--jq', '.url'], 15_000))?.trim() || null

  check.branchPullRequest = { branch, url, checkedAt: now }

  return url
}

async function pullRequestsOf($: EngineInterface, now: number): Promise<string[]> {
  const linked = await linkedPullRequestsOf($)

  if (linked.length > 0) {
    return linked
  }

  const fromBranch = await branchPullRequestOf($, now)

  return fromBranch === null ? [] : [fromBranch]
}

function stagesFrom(text: string): WatchStage[] {
  return text
    .split(',')
    .map(part => part.split('=').map(piece => piece.trim()))
    .flatMap(([branch, label]) => (branch ? [{ branch, label: label || branch }] : []))
}

async function sessionTitleOf($: EngineInterface, sessionId: string): Promise<string> {
  if (check.sessionTitle?.sessionId === sessionId) {
    return check.sessionTitle.title
  }

  const home = (await $.env.get('HOME')) ?? ''
  const found = await outputOf(
    $,
    ['find', `${home}/Library/Application Support/Claude/claude-code-sessions`, '-maxdepth', '3', '-name', `${sessionId}.json`],
    10_000,
  )
  const path = found?.split('\n').find(line => line.endsWith('.json'))
  let title = 'Claude Code'

  if (path) {
    try {
      const parsed = JSON.parse(await $.fs.read(path)) as { title?: unknown }

      title = typeof parsed.title === 'string' && parsed.title !== '' ? parsed.title : title
    } catch {
      title = 'Claude Code'
    }
  }

  check.sessionTitle = { sessionId, title }

  return title
}

async function bannerFor($: EngineInterface, event: WatchEvent): Promise<void> {
  const home = (await $.env.get('HOME')) ?? ''
  const app = check.bannerApp.replace(/^~(?=\/)/, home)
  const sessionId = await $.env.get('CLAUDE_CODE_HOST_SESSION_ID')

  if (app === '' || !sessionId || !(await $.fs.exists(app))) {
    return
  }

  const title = await sessionTitleOf($, sessionId)
  const url = `claude://claude.ai/epitaxy/${sessionId}`

  await outputOf(
    $,
    ['open', '-n', '-g', app, '--args', title, event.banner, 'Glass', CLAUDE_BUNDLE_ID, url, `${url}#${event.key}`],
    10_000,
  )
}

async function deliver($: EngineInterface, event: WatchEvent): Promise<void> {
  await $.session.append({ message: { type: 'system', content: [{ type: 'text', text: event.note }] } })

  if (check.isTellingClaude) {
    await $.session.append({
      message: { type: 'user', content: [{ type: 'text', text: `PR watch: ${event.note}` }] },
    })
  }

  await bannerFor($, event).catch(() => undefined)
}

async function watchTick($: EngineInterface): Promise<void> {
  if (check.isRunning) {
    return
  }

  check.isRunning = true

  try {
    const now = await $.clock.now()
    const urls = await pullRequestsOf($, now)

    if (urls.length === 0) {
      return
    }

    const events = await watchPullRequests($, urls, { deployWorkflow: check.deployWorkflow, stages: check.stages })

    for (const event of events) {
      await deliver($, event)
    }
  } finally {
    check.isRunning = false
  }
}

function watchEvery($: EngineInterface): void {
  check.stopWatch?.()

  const timer = $.clock.every(WATCH_EVERY_MS, () => {
    void watchTick($).catch(() => undefined)
  })

  check.stopWatch = () => timer.cancel()
}

export const register: Register = (on, options) => {
  check.stages = stagesFrom(typeof options.stages === 'string' ? options.stages : '')
  check.deployWorkflow = typeof options.deployWorkflow === 'string' ? options.deployWorkflow.trim() : ''
  check.bannerApp = typeof options.bannerApp === 'string' ? options.bannerApp.trim() : ''
  check.isTellingClaude = options.tellClaude === true

  on('session.start', async ($, e, next) => {
    const started = await next(e)

    watchEvery($)

    return started
  })
}
