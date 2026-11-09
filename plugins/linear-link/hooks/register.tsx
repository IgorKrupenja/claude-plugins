import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Ticket } from '../types'

const tickets = atom({ plugin: 'linear-link', key: 'tickets' } as const, [], {
  shape: 'tickets-2',
})

const TITLE_IDS =
  /^(?:[\w-]+(?:\([^)]*\))?!?:\s*)?([A-Z][A-Z0-9]{0,6}-\d+(?:\s*,\s*[A-Z][A-Z0-9]{0,6}-\d+)*)\s*:/
const ISSUE_ID = /[A-Z][A-Z0-9]{0,6}-\d+/g
const BRANCH_ID = /(?:^|\/)([a-z][a-z0-9]{1,4})-(\d+)(?=-|$)/i
const LINEAR_URL = /https:\/\/linear\.app\/([\w-]+)\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)(?:\/[\w%-]+)?/g
const PR_LINK_ROW = /^\{"type":"pr-link".*"prUrl":"(https:\/\/github\.com\/[^"]+\/pull\/\d+)"/
const FIGMA_URL = /https:\/\/(?:www\.)?figma\.com\/(?:design|file|proto|board|make|slides)\/[^\s)\]>"'`]+/g
const LINKED_PULL_REQUESTS = 3
const FIGMA_LINKS = 3
const PULL_REQUEST_RECHECK_MS = 5 * 60_000
const ISSUE_RECHECK_MS = 10 * 60_000

type PullRequest = { url: string; title: string; body: string; checkedAt: number }
type Issue = { url: string | null; figma: string[]; checkedAt: number }

const check = {
  workspace: '',
  linearApiKey: '',
  transcript: null as { sessionId: string; path: string | null } | null,
  pullRequests: new Map<string, PullRequest>(),
  issues: new Map<string, Issue>(),
  isRunning: false,
}

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

const transcriptOf = async ($: EngineInterface): Promise<string | null> => {
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

const linkedPullRequestsOf = async ($: EngineInterface): Promise<string[]> => {
  const transcript = await transcriptOf($)

  if (transcript === null) {
    return []
  }

  const rows = await outputOf($, ['grep', '-E', '^\\{"type":"pr-link"', transcript], 10_000)
  const urls = (rows ?? '')
    .split('\n')
    .map(row => row.match(PR_LINK_ROW)?.[1])
    .filter((url): url is string => url !== undefined)
  const newestFirst = [...new Set(urls.reverse())]

  return newestFirst.slice(0, LINKED_PULL_REQUESTS).reverse()
}

const pullRequestOf = async (
  $: EngineInterface,
  url: string | null,
  now: number,
): Promise<PullRequest | null> => {
  const cached = url === null ? undefined : check.pullRequests.get(url)

  if (cached && now - cached.checkedAt < PULL_REQUEST_RECHECK_MS) {
    return cached
  }

  const target = url === null ? [] : [url]
  const json = await outputOf($, ['gh', 'pr', 'view', ...target, '--json', 'url,title,body'], 15_000)

  if (json === null) {
    return cached ?? null
  }

  try {
    const parsed: unknown = JSON.parse(json)

    if (typeof parsed !== 'object' || parsed === null) {
      return null
    }

    const fields = parsed as Record<string, unknown>

    if (typeof fields.url !== 'string' || typeof fields.title !== 'string') {
      return null
    }

    const pullRequest: PullRequest = {
      url: fields.url,
      title: fields.title,
      body: typeof fields.body === 'string' ? fields.body : '',
      checkedAt: now,
    }

    check.pullRequests.set(pullRequest.url, pullRequest)

    return pullRequest
  } catch {
    return null
  }
}

const figmaLinksIn = (texts: readonly string[]): string[] =>
  [...new Set(texts.flatMap(text => text.match(FIGMA_URL) ?? []))].slice(0, FIGMA_LINKS)

const linearApiKeyOf = async ($: EngineInterface): Promise<string> =>
  check.linearApiKey || ((await $.env.get('LINEAR_API_KEY')) ?? '').trim()

const issuesOf = async (
  $: EngineInterface,
  ids: readonly string[],
  now: number,
): Promise<Map<string, Issue>> => {
  const stale = ids.filter(id => {
    const cached = check.issues.get(id)

    return !cached || now - cached.checkedAt >= ISSUE_RECHECK_MS
  })
  const apiKey = stale.length > 0 ? await linearApiKeyOf($) : ''

  if (apiKey !== '') {
    const fields = 'url description attachments { nodes { url } }'
    const query = `{ ${stale.map((id, index) => `i${index}: issue(id: "${id}") { ${fields} }`).join(' ')} }`

    try {
      const response = await $.http.fetch('https://api.linear.app/graphql', {
        method: 'POST',
        headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      })
      const parsed: unknown = JSON.parse(response.text)
      const data =
        typeof parsed === 'object' && parsed !== null
          ? ((parsed as { data?: Record<string, unknown> }).data ?? {})
          : {}

      stale.forEach((id, index) => {
        const issue = data[`i${index}`]

        if (typeof issue !== 'object' || issue === null) {
          return
        }

        const { url, description, attachments } = issue as {
          url?: unknown
          description?: unknown
          attachments?: { nodes?: { url?: unknown }[] }
        }
        const attachmentUrls = (attachments?.nodes ?? [])
          .map(node => node.url)
          .filter((value): value is string => typeof value === 'string')

        check.issues.set(id, {
          url: typeof url === 'string' ? url : null,
          figma: figmaLinksIn([typeof description === 'string' ? description : '', ...attachmentUrls]),
          checkedAt: now,
        })
      })
    } catch {
      return check.issues
    }
  }

  return check.issues
}

const idsInTitle = (title: string): string[] => title.match(TITLE_IDS)?.[1]?.match(ISSUE_ID) ?? []

const idsInBranch = (branch: string | null): string[] => {
  const match = branch?.match(BRANCH_ID)
  const team = match?.[1]
  const number = match?.[2]

  return team && number ? [`${team.toUpperCase()}-${number}`] : []
}

const ticketsFrom = (
  pullRequests: readonly PullRequest[],
  branch: string | null,
  workspace: string,
  issues: ReadonlyMap<string, Issue>,
): Ticket[] => {
  const links = new Map<string, string>()
  let linkedWorkspace: string | undefined

  for (const pullRequest of pullRequests) {
    for (const match of pullRequest.body.matchAll(LINEAR_URL)) {
      const id = match[2]?.toUpperCase()

      linkedWorkspace ??= match[1]

      if (id && !links.has(id)) {
        links.set(id, match[0])
      }
    }
  }

  const fromTitles = [...new Set(pullRequests.flatMap(pullRequest => idsInTitle(pullRequest.title)))]
  const ids = fromTitles.length > 0 ? fromTitles : idsInBranch(branch)
  const base = workspace || linkedWorkspace

  return ids.map(id => ({
    id,
    url:
      links.get(id) ?? issues.get(id)?.url ?? (base ? `https://linear.app/${base}/issue/${id}` : null),
    figma: issues.get(id)?.figma ?? [],
  }))
}

const isSame = (a: readonly Ticket[], b: readonly Ticket[]): boolean =>
  JSON.stringify(a) === JSON.stringify(b)

async function refresh($: EngineInterface): Promise<void> {
  if (check.isRunning) {
    return
  }

  check.isRunning = true

  try {
    const now = await $.clock.now()
    const branch = await branchOf($)
    const linked = await linkedPullRequestsOf($)
    const fetched =
      linked.length > 0
        ? await Promise.all(linked.map(url => pullRequestOf($, url, now)))
        : [branch === null ? null : await pullRequestOf($, null, now)]
    const pullRequests = fetched.filter((pullRequest): pullRequest is PullRequest => pullRequest !== null)
    const ids = ticketsFrom(pullRequests, branch, check.workspace, new Map()).map(ticket => ticket.id)
    const issues = await issuesOf($, ids, now)
    const found = ticketsFrom(pullRequests, branch, check.workspace, issues)

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
  check.linearApiKey = typeof options.linearApiKey === 'string' ? options.linearApiKey.trim() : ''

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
      const designs = ticket.figma.flatMap((href, figmaIndex) => [
        <Text dimColor> · </Text>,
        <Link href={href}>{ticket.figma.length === 1 ? 'Figma' : `Figma ${figmaIndex + 1}`}</Link>,
      ])

      return index === 0 ? [label, ...designs] : [<Text dimColor> · </Text>, label, ...designs]
    })

    return (
      <Text>
        <Text dimColor>Linear </Text>
        {parts}
      </Text>
    )
  })
}
