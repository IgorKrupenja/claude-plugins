import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Warmup } from '../types'

const warmup = atom({ plugin: 'worktree-warmup', key: 'warmup' } as const, null, {
  shape: 'warmup-1',
})

const NEEDS_DEPENDENCIES = /(^|[\s;&|(])(pnpm|npx|npm|yarn|vitest|tsc|turbo|node|scripts\/stack)(\s|$)/
const LINE_EVERY_MS = 2_000
const READY_SHOWN_MS = 30_000
const OUTPUT_LIMIT = 200_000
const LINE_LIMIT = 120
const WAITING_TIMEOUT_MS = 600_000

const settings = { command: '', trigger: '', installed: '', requires: [] as string[] }
const run = { donePath: null as string | null, isRunning: false }

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

const quoted = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`

const lastLineOf = (text: string): string =>
  (
    text
      .split(/[\r\n]+/)
      .map(line => line.trim())
      .filter(line => line !== '')
      .at(-1) ?? ''
  ).slice(0, LINE_LIMIT)

const scriptFor = (donePath: string, command: string): string =>
  [
    'if [ -f .nvmrc ] && [ -s "$HOME/.nvm/nvm.sh" ]; then . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1; nvm use >/dev/null 2>&1; fi',
    `( ${command} ) 2>&1`,
    'code=$?',
    `echo "$code" > ${quoted(donePath)}`,
    'exit "$code"',
  ].join('\n')

async function worktreeOf(
  $: EngineInterface,
  isForced: boolean,
): Promise<{ root: string; gitDir: string } | null> {
  const lines = (
    await outputOf(
      $,
      ['git', 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir'],
      5_000,
    )
  )
    ?.split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')
  const [root, gitDir, commonDir] = lines ?? []

  if (!root || !gitDir || !commonDir || gitDir === commonDir) {
    return null
  }

  if (settings.trigger !== '' && !(await $.fs.exists(`${root}/${settings.trigger}`))) {
    return null
  }

  if (!isForced && (await isReady($, root))) {
    return null
  }

  return { root, gitDir }
}

async function isReady($: EngineInterface, root: string): Promise<boolean> {
  if (settings.installed === '' || !(await $.fs.exists(`${root}/${settings.installed}`))) {
    return false
  }

  if (settings.trigger !== '') {
    const [installed, trigger] = await Promise.all([
      $.fs.stat(`${root}/${settings.installed}`),
      $.fs.stat(`${root}/${settings.trigger}`),
    ])

    if (installed.mtimeMs < trigger.mtimeMs) {
      return false
    }
  }

  for (const path of settings.requires) {
    if (!(await $.fs.exists(`${root}/${path}`))) {
      return false
    }
  }

  return true
}

async function startWarmup($: EngineInterface, isForced: boolean): Promise<void> {
  if (run.isRunning || settings.command === '') {
    return
  }

  const worktree = await worktreeOf($, isForced)

  if (worktree === null) {
    return
  }

  const startedAt = await $.clock.now()
  const donePath = `${worktree.gitDir}/worktree-warmup-${startedAt}.done`
  const logPath = `${worktree.gitDir}/worktree-warmup.log`
  let output = ''
  let shownAt = startedAt
  let code: number | null = null

  run.isRunning = true
  run.donePath = donePath
  await update($, warmup, (): Warmup => ({ status: 'running', startedAt, endedAt: null, lastLine: '', logPath }))

  try {
    const stream = $.process.spawn({
      argv: ['/bin/bash', '-c', scriptFor(donePath, settings.command)],
      cwd: worktree.root,
    })

    for await (const chunk of stream) {
      output = (output + chunk.text).slice(-OUTPUT_LIMIT)

      const now = await $.clock.now()

      if (now - shownAt >= LINE_EVERY_MS) {
        shownAt = now

        const lastLine = lastLineOf(output)

        await update($, warmup, current => (current === null ? current : { ...current, lastLine }))
      }
    }

    code = (await stream.result).code
  } catch {
    code = null
  }

  const endedAt = await $.clock.now()
  const isDone = code === 0

  await $.fs.write(logPath, output).catch(() => undefined)
  run.isRunning = false
  await update($, warmup, (current): Warmup | null =>
    current === null
      ? current
      : { ...current, status: isDone ? 'done' : 'failed', endedAt, lastLine: lastLineOf(output) },
  )

  if (isDone) {
    $.clock.after(READY_SHOWN_MS, () => {
      void update($, warmup, current => (current?.status === 'done' ? null : current)).catch(() => undefined)
    })
  }
}

function startSoon($: EngineInterface, isForced: boolean): void {
  void startWarmup($, isForced).catch(() => {
    run.isRunning = false
  })
}

const secondsBetween = (startedAt: number, endedAt: number | null): number =>
  Math.max(0, Math.round(((endedAt ?? startedAt) - startedAt) / 1000))

export const register: Register = (on, options) => {
  settings.command = typeof options.command === 'string' ? options.command.trim() : ''
  settings.trigger = typeof options.trigger === 'string' ? options.trigger.trim() : ''
  settings.installed = typeof options.installed === 'string' ? options.installed.trim() : ''
  settings.requires = (typeof options.requires === 'string' ? options.requires : '')
    .split(',')
    .map(path => path.trim())
    .filter(path => path !== '')

  on('session.start', async ($, e, next) => {
    const started = await next(e)

    startSoon($, false)

    return started
  })

  on('tool.call', { tool: 'Bash' }, ($, e, next) => {
    if (!run.isRunning || run.donePath === null || !NEEDS_DEPENDENCIES.test(e.command)) {
      return next(e)
    }

    return next({
      ...e,
      command: `while [ ! -e ${quoted(run.donePath)} ]; do sleep 2; done; ${e.command}`,
      timeout: Math.max(e.timeout ?? 0, WAITING_TIMEOUT_MS),
    })
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }

    const current = await read($, warmup)

    if (current === null) {
      return next(e)
    }

    const below = await next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const seconds = secondsBetween(current.startedAt, current.endedAt)
    let row = <Text dimColor>Worktree ready in {seconds}s</Text>

    if (current.status === 'running') {
      row = <Text dimColor>Setting up worktree: {current.lastLine || 'starting'}</Text>
    }

    if (current.status === 'failed') {
      row = (
        <Box>
          <Text>Worktree setup failed: {current.lastLine || 'no output'} </Text>
          <Button key="retry" label="Retry" onPress={() => startSoon($, true)} />
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {row}
        {below}
      </Box>
    )
  })
}
