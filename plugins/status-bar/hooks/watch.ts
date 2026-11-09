import type { EngineInterface } from 'claude-code'

export type WatchStage = { branch: string; label: string }
export type WatchSettings = { deployWorkflow: string; stages: readonly WatchStage[] }

type Watch = {
  since: string
  isFirstPoll: boolean
  inQueue: boolean
  leftQueuePolls: number
  readyHead: string
  doneBranches: string[]
  nextDeployCheckAt: number
  isFinished: boolean
}

type PullRequestState = {
  state?: string
  mergedAt?: string | null
  closedAt?: string | null
  headRefOid?: string
  mergeCommit?: { oid?: string } | null
  reviewDecision?: string | null
  mergeStateStatus?: string
  autoMergeRequest?: unknown
  author?: { login?: string } | null
  mergeQueueEntry?: unknown
  reviews?: { nodes?: { author?: { login?: string } | null; submittedAt?: string }[] }
}

type Environment =
  | { kind: 'done' }
  | { kind: 'waiting' }
  | { kind: 'deployed' | 'failed'; at: string; url: string }

const QUERY =
  'query($o:String!,$n:String!,$p:Int!){repository(owner:$o,name:$n){pullRequest(number:$p){state mergedAt closedAt headRefOid mergeCommit{oid} reviewDecision mergeStateStatus autoMergeRequest{enabledAt} author{login} mergeQueueEntry{state} reviews(last:50,states:[APPROVED]){nodes{author{login} submittedAt}}}}}'
const PULL_REQUEST_URL = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/
const RUN_FIELDS =
  '.workflow_runs[] | "\\(.created_at) \\(.id) \\(.head_sha) \\(.status) \\(.conclusion // "none") \\(.updated_at) \\(.html_url)"'
const FAILED = new Set(['failure', 'timed_out', 'startup_failure'])
const FIRST_STAGE_EVERY_MS = 60_000
const LATER_STAGE_EVERY_MS = 5 * 60_000
const HOUR_MS = 60 * 60_000

const watches = new Map<string, Watch>()
const contains = new Map<string, boolean>()

const isoSeconds = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')

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

async function containsMerge(
  $: EngineInterface,
  repository: string,
  mergeSha: string,
  sha: string,
): Promise<boolean | null> {
  const key = `${mergeSha}...${sha}`
  const known = contains.get(key)

  if (known !== undefined) {
    return known
  }

  const status = (
    await outputOf($, ['gh', 'api', `repos/${repository}/compare/${key}`, '--jq', '.status'], 15_000)
  )?.trim()

  if (status === undefined) {
    return null
  }

  const isIn = status === 'ahead' || status === 'identical'

  contains.set(key, isIn)

  return isIn
}

async function environmentOf(
  $: EngineInterface,
  repository: string,
  mergeSha: string,
  branch: string,
  runsFrom: string,
  since: string,
  workflow: string,
): Promise<Environment | null> {
  const lines = await outputOf(
    $,
    [
      'gh',
      'api',
      '--paginate',
      `repos/${repository}/actions/workflows/${workflow}/runs?branch=${branch}&event=push&per_page=100&created=%3E%3D${runsFrom}`,
      '--jq',
      RUN_FIELDS,
    ],
    30_000,
  )

  if (lines === null) {
    return null
  }

  let isReached = false
  let isDeployedBefore = false
  let isRunning = false
  let deployed: { at: string; url: string } | null = null
  let failed: { at: string; url: string } | null = null

  for (const line of lines.split('\n').filter(row => row.trim() !== '').sort()) {
    const fields = line.split(' ')
    const sha = fields[2]
    const status = fields[3]
    const conclusion = fields[4] ?? ''
    const updated = fields[5]
    const url = fields[6]

    if (!sha || !status || !updated || !url) {
      continue
    }

    if (!isReached) {
      const isIn = await containsMerge($, repository, mergeSha, sha)

      if (isIn === null) {
        return null
      }

      if (!isIn) {
        continue
      }

      isReached = true
    }

    if (status !== 'completed') {
      isRunning = true
    } else if (conclusion === 'success') {
      if (updated > since) {
        deployed ??= { at: updated, url }
      } else {
        isDeployedBefore = true
      }
    } else if (FAILED.has(conclusion) && updated > since) {
      failed = { at: updated, url }
    }
  }

  if (isDeployedBefore) {
    return { kind: 'done' }
  }

  if (deployed !== null) {
    return { kind: 'deployed', ...deployed }
  }

  if (failed !== null && !isRunning) {
    return { kind: 'failed', ...failed }
  }

  return { kind: 'waiting' }
}

async function deployEventOf(
  $: EngineInterface,
  repository: string,
  label: string,
  pullRequest: PullRequestState,
  watch: Watch,
  settings: WatchSettings,
  now: number,
): Promise<string | null> {
  const mergeSha = pullRequest.mergeCommit?.oid
  const mergedAt = Date.parse(pullRequest.mergedAt ?? '')

  if (!mergeSha || !Number.isFinite(mergedAt) || settings.stages.length === 0 || settings.deployWorkflow === '') {
    watch.isFinished = true

    return null
  }

  if (now < watch.nextDeployCheckAt) {
    return null
  }

  const runsFrom = isoSeconds(mergedAt - HOUR_MS)

  for (const [index, stage] of settings.stages.entries()) {
    if (watch.doneBranches.includes(stage.branch)) {
      continue
    }

    const environment = await environmentOf(
      $,
      repository,
      mergeSha,
      stage.branch,
      runsFrom,
      watch.since,
      settings.deployWorkflow,
    )

    if (environment === null) {
      watch.nextDeployCheckAt = now + FIRST_STAGE_EVERY_MS

      return null
    }

    if (environment.kind === 'done') {
      watch.doneBranches.push(stage.branch)
      continue
    }

    if (environment.kind === 'deployed') {
      watch.doneBranches.push(stage.branch)
      watch.since = environment.at

      return `${label} DEPLOYED to ${stage.label} at ${environment.at}: ${environment.url}`
    }

    if (environment.kind === 'failed') {
      watch.since = environment.at

      return `${label} DEPLOY to ${stage.label} FAILED at ${environment.at}: ${environment.url}`
    }

    watch.nextDeployCheckAt = now + (index === 0 ? FIRST_STAGE_EVERY_MS : LATER_STAGE_EVERY_MS)

    return null
  }

  watch.isFinished = true

  return null
}

async function eventOf(
  $: EngineInterface,
  url: string,
  watch: Watch,
  settings: WatchSettings,
  now: number,
): Promise<string | null> {
  const [, owner, name, number] = url.match(PULL_REQUEST_URL) ?? []

  if (!owner || !name || !number) {
    watch.isFinished = true

    return null
  }

  const json = await outputOf(
    $,
    ['gh', 'api', 'graphql', '-f', `query=${QUERY}`, '-F', `o=${owner}`, '-F', `n=${name}`, '-F', `p=${number}`],
    20_000,
  )
  let pullRequest: PullRequestState | undefined

  try {
    pullRequest = (JSON.parse(json ?? '') as { data?: { repository?: { pullRequest?: PullRequestState } } })
      .data?.repository?.pullRequest
  } catch {
    return null
  }

  if (!pullRequest) {
    return null
  }

  const label = `PR #${number}`

  if (pullRequest.state === 'MERGED') {
    const mergedAt = pullRequest.mergedAt ?? ''

    if (mergedAt > watch.since) {
      watch.since = mergedAt

      return `${label} MERGED at ${mergedAt}`
    }

    return deployEventOf($, `${owner}/${name}`, label, pullRequest, watch, settings, now)
  }

  if (pullRequest.state === 'CLOSED') {
    const closedAt = pullRequest.closedAt ?? ''

    watch.isFinished = true

    return closedAt > watch.since ? `${label} CLOSED without merging at ${closedAt}` : null
  }

  if (pullRequest.state !== 'OPEN') {
    return null
  }

  const author = pullRequest.author?.login
  const approvals = (pullRequest.reviews?.nodes ?? []).filter(
    review => (review.submittedAt ?? '') > watch.since && review.author?.login !== author,
  )

  if (approvals.length > 0) {
    watch.since = approvals.map(review => review.submittedAt ?? '').sort().at(-1) ?? watch.since

    return approvals
      .map(review => `${label} APPROVED by ${review.author?.login ?? 'someone'} at ${review.submittedAt}`)
      .join('\n')
  }

  if (pullRequest.mergeQueueEntry) {
    watch.inQueue = true
    watch.leftQueuePolls = 0
  } else if (watch.inQueue) {
    watch.leftQueuePolls += 1

    if (watch.leftQueuePolls >= 2) {
      const at = isoSeconds(now)

      watch.inQueue = false
      watch.leftQueuePolls = 0
      watch.since = at

      return `${label} LEFT THE MERGE QUEUE without merging at ${at}`
    }
  }

  const isReady =
    pullRequest.reviewDecision === 'APPROVED' &&
    pullRequest.mergeStateStatus === 'CLEAN' &&
    !pullRequest.autoMergeRequest
  const head = pullRequest.headRefOid ?? ''
  const wasFirstPoll = watch.isFirstPoll

  watch.isFirstPoll = false

  if (isReady) {
    const isNewHead = head !== watch.readyHead

    watch.readyHead = head

    if (!wasFirstPoll && isNewHead) {
      const at = isoSeconds(now)

      watch.since = at

      return `${label} READY to merge at ${at} on ${head.slice(0, 9)}: approved, checks green, auto-merge off`
    }
  }

  return null
}

export async function watchPullRequests(
  $: EngineInterface,
  urls: readonly string[],
  settings: WatchSettings,
): Promise<string[]> {
  const now = await $.clock.now()
  const messages: string[] = []

  for (const url of urls) {
    let watch = watches.get(url)

    if (watch === undefined) {
      watch = {
        since: isoSeconds(now),
        isFirstPoll: true,
        inQueue: false,
        leftQueuePolls: 0,
        readyHead: '',
        doneBranches: [],
        nextDeployCheckAt: 0,
        isFinished: false,
      }
      watches.set(url, watch)
    }

    if (watch.isFinished) {
      continue
    }

    const message = await eventOf($, url, watch, settings, now)

    if (message !== null) {
      messages.push(message)
    }
  }

  return messages
}
