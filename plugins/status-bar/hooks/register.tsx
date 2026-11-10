import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Preview, Ticket } from '../types'

const tickets = atom({ plugin: 'status-bar', key: 'tickets' } as const, [], {
  shape: 'tickets-3',
})
const stage = atom({ plugin: 'status-bar', key: 'stage' } as const, null)
const preview = atom({ plugin: 'status-bar', key: 'preview' } as const, null, {
  shape: 'preview-1',
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
const STAGE_RECHECK_MS = 10 * 60_000
const PULL_REQUEST_REPOSITORY = /github\.com\/([^/]+\/[^/]+)\/pull\/\d+/
const DEPLOYING_RECHECK_MS = 60_000
const HOUR_MS = 60 * 60_000

type PullRequest = {
  url: string
  number: number
  isOpen: boolean
  title: string
  body: string
  mergeCommit: string | null
  baseBranch: string
  headBranch: string
  checkedAt: number
}
type Issue = { url: string | null; state: string | null; figma: string[]; checkedAt: number }
type Stage = { branch: string; label: string }
type PreviewLink = { label: string; template: string }

const check = {
  workspace: '',
  linearApiKey: '',
  stages: [] as Stage[],
  previewLinks: [] as PreviewLink[],
  previewWorkflow: '',
  previewIdleMs: 48 * HOUR_MS,
  transcript: null as { sessionId: string; path: string | null } | null,
  promptLinks: null as { transcript: string; links: Map<string, string> } | null,
  pullRequests: new Map<string, PullRequest>(),
  issues: new Map<string, Issue>(),
  deployed: new Map<string, { label: string | null; checkedAt: number }>(),
  stopTimer: null as (() => void) | null,
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

const textOf = (row: string): string => {
  try {
    const content = (JSON.parse(row) as { message?: { content?: unknown } }).message?.content

    if (typeof content === 'string') {
      return content
    }

    return Array.isArray(content)
      ? content.map(block => ((block as { text?: unknown }).text as string | undefined) ?? '').join('\n')
      : ''
  } catch {
    return ''
  }
}

const promptLinksOf = async ($: EngineInterface): Promise<Map<string, string>> => {
  const transcript = await transcriptOf($)

  if (transcript === null) {
    return new Map()
  }

  if (check.promptLinks?.transcript === transcript && check.promptLinks.links.size > 0) {
    return check.promptLinks.links
  }

  const rows = await outputOf($, ['grep', '-F', '"kind":"human"', transcript], 10_000)
  const links = new Map<string, string>()

  for (const row of (rows ?? '').split('\n')) {
    for (const match of textOf(row).matchAll(LINEAR_URL)) {
      const id = match[2]?.toUpperCase()

      if (id && !links.has(id)) {
        links.set(id, match[0])
      }
    }

    if (links.size > 0) {
      break
    }
  }

  check.promptLinks = { transcript, links }

  return links
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
  const json = await outputOf(
    $,
    [
      'gh',
      'pr',
      'view',
      ...target,
      '--json',
      'url,number,state,title,body,mergeCommit,baseRefName,headRefName',
    ],
    15_000,
  )

  if (json === null) {
    return cached ?? null
  }

  try {
    const parsed: unknown = JSON.parse(json)

    if (typeof parsed !== 'object' || parsed === null) {
      return null
    }

    const fields = parsed as Record<string, unknown>

    if (
      typeof fields.url !== 'string' ||
      typeof fields.title !== 'string' ||
      typeof fields.number !== 'number'
    ) {
      return null
    }

    const mergeCommit = (fields.mergeCommit as { oid?: unknown } | null | undefined)?.oid
    const pullRequest: PullRequest = {
      url: fields.url,
      number: fields.number,
      isOpen: fields.state === 'OPEN',
      title: fields.title,
      body: typeof fields.body === 'string' ? fields.body : '',
      mergeCommit: typeof mergeCommit === 'string' ? mergeCommit : null,
      baseBranch: typeof fields.baseRefName === 'string' ? fields.baseRefName : '',
      headBranch: typeof fields.headRefName === 'string' ? fields.headRefName : '',
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
    const fields = 'url description state { name } attachments { nodes { url } }'
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

        const { url, description, state, attachments } = issue as {
          url?: unknown
          description?: unknown
          state?: { name?: unknown } | null
          attachments?: { nodes?: { url?: unknown }[] }
        }
        const attachmentUrls = (attachments?.nodes ?? [])
          .map(node => node.url)
          .filter((value): value is string => typeof value === 'string')

        check.issues.set(id, {
          url: typeof url === 'string' ? url : null,
          state: typeof state?.name === 'string' ? state.name : null,
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

const stagesFrom = (text: string): Stage[] =>
  text
    .split(',')
    .map(part => part.split('=').map(piece => piece.trim()))
    .flatMap(([branch, label]) => (branch ? [{ branch, label: label || branch }] : []))

const containsCommit = async (
  $: EngineInterface,
  repository: string,
  commit: string,
  branch: string,
): Promise<boolean> => {
  const status = (
    await outputOf($, ['gh', 'api', `repos/${repository}/compare/${commit}...${branch}`, '--jq', '.status'], 15_000)
  )?.trim()

  return status === 'ahead' || status === 'identical'
}

const stageOf = async (
  $: EngineInterface,
  pullRequest: PullRequest | undefined,
  now: number,
): Promise<string | null> => {
  const repository = pullRequest?.url.match(PULL_REQUEST_REPOSITORY)?.[1]

  if (!pullRequest || pullRequest.mergeCommit === null || !repository || check.stages.length === 0) {
    return null
  }

  const cached = check.deployed.get(pullRequest.url)
  const finalLabel = check.stages.at(-1)?.label

  if (cached && (cached.label === finalLabel || now - cached.checkedAt < STAGE_RECHECK_MS)) {
    return cached.label
  }

  let label: string | null = null

  for (const candidate of check.stages) {
    const isIn =
      candidate.branch === pullRequest.baseBranch ||
      (await containsCommit($, repository, pullRequest.mergeCommit, candidate.branch))

    if (isIn) {
      label = candidate.label
    }
  }

  check.deployed.set(pullRequest.url, { label, checkedAt: now })

  return label
}

const previewLinksFrom = (text: string): PreviewLink[] =>
  text
    .split(',')
    .map(part => part.trim())
    .flatMap(part => {
      const equals = part.indexOf('=')
      const label = part.slice(0, equals).trim()
      const template = part.slice(equals + 1).trim()

      return equals > 0 && template.startsWith('https://') ? [{ label, template }] : []
    })

const previewOf = async (
  $: EngineInterface,
  pullRequest: PullRequest | undefined,
  now: number,
): Promise<Preview | null> => {
  const repository = pullRequest?.url.match(PULL_REQUEST_REPOSITORY)?.[1]

  if (
    !pullRequest?.isOpen ||
    !repository ||
    pullRequest.headBranch === '' ||
    check.previewWorkflow === '' ||
    check.previewLinks.length === 0
  ) {
    return null
  }

  const json = await outputOf(
    $,
    [
      'gh',
      'run',
      'list',
      '-R',
      repository,
      '--workflow',
      check.previewWorkflow,
      '--branch',
      pullRequest.headBranch,
      '--limit',
      '1',
      '--json',
      'status,conclusion,event,createdAt,url',
    ],
    15_000,
  )

  try {
    const [run] = JSON.parse(json ?? '[]') as {
      status?: unknown
      conclusion?: unknown
      event?: unknown
      createdAt?: unknown
      url?: unknown
    }[]

    if (!run || run.event !== 'workflow_dispatch' || typeof run.url !== 'string') {
      return null
    }

    if (run.status !== 'completed') {
      return { status: 'deploying', runUrl: run.url, links: [] }
    }

    if (run.conclusion !== 'success') {
      return { status: 'failed', runUrl: run.url, links: [] }
    }

    const startedAt = typeof run.createdAt === 'string' ? Date.parse(run.createdAt) : Number.NaN

    if (!Number.isFinite(startedAt) || now - startedAt > check.previewIdleMs) {
      return null
    }

    return {
      status: 'ready',
      runUrl: run.url,
      links: check.previewLinks.map(({ label, template }) => ({
        label,
        href: template.replaceAll('{number}', String(pullRequest.number)),
      })),
    }
  } catch {
    return null
  }
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
  promptLinks: ReadonlyMap<string, string>,
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
  const fromBranch = fromTitles.length > 0 ? fromTitles : idsInBranch(branch)
  const ids = fromBranch.length > 0 ? fromBranch : [...promptLinks.keys()]
  const base = workspace || linkedWorkspace

  return ids.map(id => ({
    id,
    url:
      links.get(id) ??
      promptLinks.get(id) ??
      issues.get(id)?.url ??
      (base ? `https://linear.app/${base}/issue/${id}` : null),
    state: issues.get(id)?.state ?? null,
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
    const promptLinks = await promptLinksOf($)
    const ids = ticketsFrom(pullRequests, branch, promptLinks, check.workspace, new Map()).map(
      ticket => ticket.id,
    )
    const issues = await issuesOf($, ids, now)
    const found = ticketsFrom(pullRequests, branch, promptLinks, check.workspace, issues)
    const deployed = await stageOf($, pullRequests.at(-1), now)
    const deployment = await previewOf($, pullRequests.at(-1), now)

    await update($, tickets, previous => (isSame(previous, found) ? previous : found))
    await update($, stage, () => deployed)
    await update($, preview, previous =>
      JSON.stringify(previous) === JSON.stringify(deployment) ? previous : deployment,
    )

    if (deployment?.status === 'deploying') {
      refreshLater($, DEPLOYING_RECHECK_MS)
    }
  } finally {
    check.isRunning = false
  }
}

function refreshSoon($: EngineInterface): void {
  $.clock.after(0, () => {
    void refresh($).catch(() => undefined)
  })
}

function refreshLater($: EngineInterface, ms: number): void {
  $.clock.after(ms, () => {
    void refresh($).catch(() => undefined)
  })
}

function refreshEvery($: EngineInterface): void {
  check.stopTimer?.()

  const timer = $.clock.every(STAGE_RECHECK_MS, () => {
    void refresh($).catch(() => undefined)
  })

  check.stopTimer = () => timer.cancel()
}

export const register: Register = (on, options) => {
  check.workspace = typeof options.workspace === 'string' ? options.workspace.trim() : ''
  check.linearApiKey = typeof options.linearApiKey === 'string' ? options.linearApiKey.trim() : ''
  check.stages = stagesFrom(typeof options.stages === 'string' ? options.stages : '')
  check.previewLinks = previewLinksFrom(typeof options.previewLinks === 'string' ? options.previewLinks : '')
  check.previewWorkflow = typeof options.previewWorkflow === 'string' ? options.previewWorkflow.trim() : ''
  check.previewIdleMs =
    (typeof options.previewIdleHours === 'number' && options.previewIdleHours > 0
      ? options.previewIdleHours
      : 48) * HOUR_MS

  on('session.start', async ($, e, next) => {
    const started = await next(e)

    refreshSoon($)
    refreshEvery($)

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
    const deployed = await read($, stage)
    const deployment = await read($, preview)

    if (list.length === 0 && deployment === null) {
      return next(e)
    }

    const below = await next(e)
    const { Box, Link, Text } = $.ui.resolve(e)
    const parts = list.flatMap((ticket, index) => {
      const label =
        ticket.url === null ? <Text>{ticket.id}</Text> : <Link href={ticket.url}>{ticket.id}</Link>
      const state = ticket.state === null ? [] : [<Text dimColor> {ticket.state}</Text>]
      const designs = ticket.figma.flatMap((href, figmaIndex) => [
        <Text dimColor> · </Text>,
        <Link href={href}>{ticket.figma.length === 1 ? 'Figma' : `Figma ${figmaIndex + 1}`}</Link>,
      ])

      return index === 0
        ? [label, ...state, ...designs]
        : [<Text dimColor> · </Text>, label, ...state, ...designs]
    })
    const stageText = deployed === null ? [] : [<Text dimColor> · on {deployed}</Text>]
    const previewParts = (() => {
      if (deployment === null) {
        return []
      }

      if (deployment.status === 'deploying') {
        return [<Link href={deployment.runUrl}>Preview deploying</Link>]
      }

      if (deployment.status === 'failed') {
        return [<Link href={deployment.runUrl}>Preview failed</Link>]
      }

      return deployment.links.flatMap((link, index) =>
        index === 0 ? [<Link href={link.href}>{link.label}</Link>] : [<Text dimColor> · </Text>, <Link href={link.href}>{link.label}</Link>],
      )
    })()
    const previewText =
      previewParts.length === 0 ? [] : list.length === 0 ? previewParts : [<Text dimColor> · </Text>, ...previewParts]

    return (
      <Box flexDirection="column">
        <Text>
          {list.length === 0 ? [] : [<Text dimColor>Linear </Text>]}
          {parts}
          {stageText}
          {previewText}
        </Text>
        {below}
      </Box>
    )
  })
}
