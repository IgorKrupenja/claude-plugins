export type Ticket = { id: string; url: string | null; state: string | null; figma: string[] }

declare module 'claude-code' {
  interface PluginState {
    'linear-link': { tickets: Shaped<Ticket[]>; stage: string | null }
  }
}
