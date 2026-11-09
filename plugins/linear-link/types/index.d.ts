export type Ticket = { id: string; url: string | null }

declare module 'claude-code' {
  interface PluginState {
    'linear-link': { tickets: Shaped<Ticket[]> }
  }
}
