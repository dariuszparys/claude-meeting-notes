export type Note = { at: number; text: string }

/** Where the call's audio comes from: the system-audio helper or a loopback input. */
export type CallSource = 'system' | 'device'

/** One stretch of recording: raw 16 kHz mono PCM per source. */
export type Segment = {
  startedAt: number
  endedAt?: number
  mic: string
  meeting?: string
  call?: CallSource
}

export type Phase = 'live' | 'processing' | 'done' | 'failed'

export type Meeting = {
  title: string
  dir: string
  startedAt: number
  endedAt?: number
  notes: Note[]
  segments: Segment[]
  isRecording: boolean
  isTranscribed: boolean
  phase: Phase
  step?: string
  error?: string
  summary?: string
  warnings: string[]
}

/** Peak level in dB over the last seconds of each source; isCallHeard once the call was ever audible. */
export type Levels = { mic?: number; meeting?: number; isCallHeard?: boolean }

declare module 'claude-code' {
  interface PluginState {
    'meeting-notes': {
      meeting: Meeting | null
      levels: Levels | null
      now: number
      /** What /meeting setup found missing, by name; null before the first check. */
      missing: string[] | null
    }
  }
}
