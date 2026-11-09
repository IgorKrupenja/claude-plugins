import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

const BAND = {
  plugin: 'worktree-warmup',
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

const ROOT = '/repo/.claude/worktrees/wt'
const GIT_DIR = '/repo/.git/worktrees/wt'
const COMMON_DIR = '/repo/.git'

type World = {
  isWorktree?: boolean
  files?: Readonly<Record<string, boolean>>
  output?: readonly string[]
  code?: number
  gate?: Promise<void>
}

const ran = (exitCode: number, stdout: string) => ({
  value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

const start = async ($: Engine, on: On, world: World) => {
  const clock = mock.clock(on)
  const spawned: { argv: readonly string[]; cwd?: string }[] = []
  const commands: string[] = []
  const files = world.files ?? { [`${ROOT}/pnpm-lock.yaml`]: true }

  on('process.run', () =>
    world.isWorktree === false
      ? ran(0, `/repo\n${COMMON_DIR}\n${COMMON_DIR}\n`)
      : ran(0, `${ROOT}\n${GIT_DIR}\n${COMMON_DIR}\n`),
  )
  on('fs.exists', (_, e) => ({ value: files[e.path] ?? false }))
  on('fs.write', () => ({ value: undefined }))
  on('process.spawn', async function* (_, e) {
    spawned.push({ argv: e.argv, cwd: e.cwd })

    for (const text of world.output ?? ['Progress: resolved 1\n', 'Done in 3s\n']) {
      yield { stream: 'stdout' as const, text }
    }

    await world.gate

    return { value: { code: world.code ?? 0, signal: null } }
  })
  on('tool.call', (_, e) => {
    commands.push(String((e as { command?: unknown }).command))

    return { result: {} }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })

  await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
  await clock.advance(1)

  return { clock, spawned, commands }
}

test('sets up a new worktree in the background and says when it is ready', async ($, on) => {
  const { clock, spawned } = await start($, on, {})

  expect(spawned).toHaveLength(1)
  expect(spawned[0]?.cwd).toBe(ROOT)
  expect(spawned[0]?.argv.join(' ')).toContain('pnpm install --frozen-lockfile')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })

    expect((await ui.find({ type: 'Text', text: /^Worktree ready in/ }))?.text).toBe('Worktree ready in 0s')
    expect((await ui.find({ type: 'Text', text: /^engine$/ }))?.text).toBe('engine')
    await ui.unmount()
  }

  await clock.advance(30_001)

  const later = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect(await later.find({ type: 'Text', text: /Worktree/ })).toBeUndefined()
  await later.unmount()
})

test('leaves the primary checkout alone', async ($, on) => {
  const { spawned } = await start($, on, { isWorktree: false })

  expect(spawned).toHaveLength(0)
})

test('leaves an installed worktree alone', async ($, on) => {
  const { spawned } = await start($, on, {
    files: { [`${ROOT}/pnpm-lock.yaml`]: true, [`${ROOT}/node_modules`]: true },
  })

  expect(spawned).toHaveLength(0)
})

test('leaves a worktree without the trigger file alone', async ($, on) => {
  const { spawned } = await start($, on, { files: {} })

  expect(spawned).toHaveLength(0)
})

test('shows a failed setup with its last line and retries it', async ($, on) => {
  const { clock, spawned } = await start($, on, {
    output: ['ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with frozen-lockfile\n'],
    code: 1,
  })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect((await ui.find({ type: 'Text', text: /^Worktree setup failed/ }))?.text).toBe(
    'Worktree setup failed: ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with frozen-lockfile ',
  )
  await ui.press({ key: 'retry' })
  await clock.advance(1)
  expect(spawned).toHaveLength(2)
  await ui.unmount()
})

test('makes a command that needs dependencies wait for the setup', async ($, on) => {
  let release = () => {}
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const { clock, commands } = await start($, on, { gate })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect((await ui.find({ type: 'Text', text: /^Setting up this worktree/ }))?.text).toBe(
    'Setting up this worktree: starting',
  )
  await ui.unmount()

  await $.tool.call({ tool: 'Bash', command: 'pnpm test' })
  await $.tool.call({ tool: 'Bash', command: 'git status' })

  expect(commands[0]).toMatch(
    new RegExp(`^while \\[ ! -e '${GIT_DIR}/worktree-warmup-\\d+\\.done' \\]; do sleep 2; done; pnpm test$`),
  )
  expect(commands[1]).toBe('git status')

  release()
  await clock.advance(1)
  await $.tool.call({ tool: 'Bash', command: 'pnpm test' })
  expect(commands[2]).toBe('pnpm test')
})
