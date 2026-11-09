export type Ticket = { id: string; url: string | null; state: string | null; figma: string[] }

export type Preview = {
  status: 'ready' | 'deploying' | 'failed'
  runUrl: string
  links: { label: string; href: string }[]
}

declare module 'claude-code' {
  interface PluginState {
    'linear-link': { tickets: Shaped<Ticket[]>; stage: string | null; preview: Shaped<Preview | null> }
  }
}
