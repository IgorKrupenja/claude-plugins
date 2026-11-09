export type Warmup = {
  status: 'running' | 'done' | 'failed'
  startedAt: number
  endedAt: number | null
  lastLine: string
  logPath: string
}

declare module 'claude-code' {
  interface PluginState {
    'worktree-warmup': { warmup: Shaped<Warmup | null> }
  }
}
