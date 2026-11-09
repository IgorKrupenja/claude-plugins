import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Ticket } from '../types'

const tickets = atom({ plugin: 'linear-link', key: 'tickets' } as const, [], {
  shape: 'tickets-1',
})

const TITLE_IDS =
  /^(?:[\w-]+(?:\([^)]*\))?!?:\s*)?([A-Z][A-Z0-9]{0,6}-\d+(?:\s*,\s*[A-Z][A-Z0-9]{0,6}-\d+)*)\s*:/
const ISSUE_ID = /[A-Z][A-Z0-9]{0,6}-\d+/g
const BRANCH_ID = /(?:^|\/)([a-z][a-z0-9]{1,4})-(\d+)(?=-|$)/i
const LINEAR_URL = /https:\/\/linear\.app\/([\w-]+)\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)(?:\/[\w%-]+)?/g
const PULL_REQUEST_RECHECK_MS = 5 * 60_000

type PullRequest = { title: string; body: string }

const outputOf = async (
  $: EngineInterface,
  argv: readonly string[],
  timeoutMs: number,
): Promise<string | null> => {
  try {
    const { exitCode, stdout } = await $.process.run(argv, { timeoutMs })

    return exitCode === 0 ? stdout : null
  } catch {
    return null
  }
}

const branchOf = async ($: EngineInterface): Promise<string | null> => {
  const branch = (await outputOf($, ['git', 'branch', '--show-current'], 5_000))?.trim()

  return branch ? branch : null
}

const pullRequestOf = async ($: EngineInterface): Promise<PullRequest | null> => {
  const json = await outputOf($, ['gh', 'pr', 'view', '--json', 'title,body'], 15_000)

  if (json === null) {
    return null
  }

  try {
    const parsed: unknown = JSON.parse(json)

    if (typeof parsed !== 'object' || parsed === null) {
      return null
    }

    const { title, body } = parsed as Record<string, unknown>

    return typeof title === 'string'
      ? { title, body: typeof body === 'string' ? body : '' }
      : null
  } catch {
    return null
  }
}

const unique = (ids: readonly string[]): string[] => [...new Set(ids)]

const idsInTitle = (title: string): string[] =>
  unique(title.match(TITLE_IDS)?.[1]?.match(ISSUE_ID) ?? [])

const idsInBranch = (branch: string | null): string[] => {
  const match = branch?.match(BRANCH_ID)
  const team = match?.[1]
  const number = match?.[2]

  return team && number ? [`${team.toUpperCase()}-${number}`] : []
}

const ticketsFrom = (
  branch: string | null,
  pullRequest: PullRequest | null,
  workspace: string,
): Ticket[] => {
  const links = new Map<string, string>()
  let linkedWorkspace: string | undefined

  for (const match of (pullRequest?.body ?? '').matchAll(LINEAR_URL)) {
    const id = match[2]?.toUpperCase()

    linkedWorkspace ??= match[1]

    if (id && !links.has(id)) {
      links.set(id, match[0])
    }
  }

  const fromTitle = pullRequest === null ? [] : idsInTitle(pullRequest.title)
  const fromBranch = fromTitle.length > 0 ? fromTitle : idsInBranch(branch)
  const ids = fromBranch.length > 0 ? fromBranch : [...links.keys()]
  const base = workspace || linkedWorkspace

  return ids.map(id => ({
    id,
    url: links.get(id) ?? (base ? `https://linear.app/${base}/issue/${id}` : null),
  }))
}

const isSame = (a: readonly Ticket[], b: readonly Ticket[]): boolean =>
  a.length === b.length && a.every((ticket, index) => ticket.id === b[index]?.id && ticket.url === b[index]?.url)

const check = {
  workspace: '',
  branch: undefined as string | null | undefined,
  checkedAt: 0,
  hasPullRequest: false,
  isRunning: false,
}

async function refresh($: EngineInterface): Promise<void> {
  if (check.isRunning) {
    return
  }

  check.isRunning = true

  try {
    const branch = await branchOf($)
    const now = await $.clock.now()
    const isFresh =
      branch === check.branch && check.hasPullRequest && now - check.checkedAt < PULL_REQUEST_RECHECK_MS

    if (isFresh) {
      return
    }

    const pullRequest = branch === null ? null : await pullRequestOf($)
    const found = ticketsFrom(branch, pullRequest, check.workspace)

    check.branch = branch
    check.checkedAt = now
    check.hasPullRequest = pullRequest !== null
    await update($, tickets, previous => (isSame(previous, found) ? previous : found))
  } finally {
    check.isRunning = false
  }
}

function refreshSoon($: EngineInterface): void {
  $.clock.after(0, () => {
    void refresh($).catch(() => undefined)
  })
}

export const register: Register = (on, options) => {
  check.workspace = typeof options.workspace === 'string' ? options.workspace.trim() : ''

  on('session.start', async ($, e, next) => {
    const started = await next(e)

    refreshSoon($)

    return started
  })

  on('turn.complete', async ($, e, next) => {
    const completed = await next(e)

    refreshSoon($)

    return completed
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }

    const list = await read($, tickets)

    if (list.length === 0) {
      return next(e)
    }

    const { Link, Text } = $.ui.resolve(e)
    const parts = list.flatMap((ticket, index) => {
      const label =
        ticket.url === null ? <Text>{ticket.id}</Text> : <Link href={ticket.url}>{ticket.id}</Link>

      return index === 0 ? [label] : [<Text dimColor> · </Text>, label]
    })

    return (
      <Text>
        <Text dimColor>Linear </Text>
        {parts}
      </Text>
    )
  })
}
