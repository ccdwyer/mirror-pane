export type Device = { kind: 'ios' | 'android'; id: string }
export type Pair = {
  id: number
  file: string
  device: string
  before: string | null
  after: string
  changed: number | null
  drift: number | null
  // Another edit to the same device landed while this pair was being taken, so the change isn't this edit's alone.
  overlapped?: boolean
  at: number
}

declare module 'claude-code' {
  interface PluginState {
    'mirror-pane': {
      pairs: Pair[]
      cursor: number
      isOn: boolean
      // Which one-time hints were shown: 'several', 'phone', 'quiet'. Each is cleared when its condition ends.
      warned: string[]
      quietUntil: number
    }
  }
}
