import type { Meeting } from '../types'

/** One transcribed segment, placed on the wall clock. */
export type Line = { at: number; offsetMs: number; speaker?: string; text: string }

/** Below this peak a source counts as silent. */
export const SILENT_DB = -60

const pad = (n: number) => String(n).padStart(2, '0')

export function expandHome(path: string, home: string): string {
  if (path === '~') return home
  return path.startsWith('~/') ? `${home}${path.slice(1)}` : path
}

/** `date +%z` output ("+0100") as minutes east of UTC. */
export function parseOffset(text: string): number {
  const match = /([+-])(\d\d)(\d\d)/.exec(text)
  if (!match) return 0
  const minutes = Number(match[2]) * 60 + Number(match[3])
  return match[1] === '-' ? -minutes : minutes
}

// The plugin environment's time zone is unknown, so local time is the UTC
// fields of a timestamp shifted by the offset the host reported.
function local(ms: number, offset: number): Date {
  return new Date(ms + offset * 60_000)
}

export function clockTime(ms: number, offset: number, withSeconds = false): string {
  const d = local(ms, offset)
  const hm = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
  return withSeconds ? `${hm}:${pad(d.getUTCSeconds())}` : hm
}

export function dateStamp(ms: number, offset: number): string {
  const d = local(ms, offset)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

/** "12:03" below an hour, "1:05:03" from there. */
export function elapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}

export function folderName(startedAt: number, offset: number, title: string): string {
  const time = clockTime(startedAt, offset).replace(':', '')
  const safe = title.replace(/[/\\:*?"<>|\n\r\t]+/g, '-').replace(/^[.\s-]+/, '').trim().slice(0, 80)
  return `${dateStamp(startedAt, offset)} ${time} ${safe || 'Meeting'}`
}

/** Audio device names from `ffmpeg -f avfoundation -list_devices true -i ""`. */
export function parseAudioDevices(stderr: string): string[] {
  const audio = stderr.split('AVFoundation audio devices:')[1] ?? ''
  return [...audio.matchAll(/\]\s\[\d+\]\s(.+)$/gm)].map(m => (m[1] ?? '').trim())
}

/** Peak level from ffmpeg's volumedetect filter. */
export function parseLevel(stderr: string): number | undefined {
  const match = /max_volume:\s*(-?[\d.]+|-inf) dB/.exec(stderr)
  if (!match) return undefined
  return match[1] === '-inf' ? -91 : Number(match[1])
}

/** The newest "level <dB>" line the system-audio helper printed. */
export function parseHelperLevel(text: string): number | undefined {
  const levels = [...text.matchAll(/^level (-?[\d.]+)$/gm)]
  const last = levels.at(-1)?.[1]
  return last === undefined ? undefined : Number(last)
}

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
}

export function levelLabel(db: number | undefined): string {
  if (db === undefined) return '…'
  return db <= SILENT_DB ? 'silent' : `${Math.round(db)} dB`
}

const LINE = /^\[(\d+):(\d\d):(\d\d)\.(\d{3}) --> [^\]]*\]\s*(?:\(speaker (\d|\?)\)\s*)?(.*)$/
const NOISE = /^[[(][^\])]*[\])]$/

/**
 * One line of whisper-cli's output: `[00:01:02.000 --> ...]  (speaker 0) text`.
 * With stereo diarization speaker 0 is the left channel (the mic), 1 the call.
 */
export function parseWhisperLine(text: string, startedAt: number): Line | undefined {
  const match = LINE.exec(text.trim())
  if (!match) return undefined
  const [, h, m, s, ms, speaker, rest = ''] = match
  const said = rest.trim()
  if (!said || NOISE.test(said)) return undefined
  const offsetMs = ((Number(h) * 60 + Number(m)) * 60 + Number(s)) * 1000 + Number(ms)
  const who = speaker === '0' ? 'Me' : speaker === '1' ? 'Others' : undefined
  return { at: startedAt + offsetMs, offsetMs, text: said, ...(who ? { speaker: who } : {}) }
}

function span(m: Meeting, offset: number): string {
  const end = m.endedAt ?? m.startedAt
  const minutes = Math.max(1, Math.round((end - m.startedAt) / 60_000))
  const range = m.endedAt === undefined
    ? `from ${clockTime(m.startedAt, offset)}`
    : `${clockTime(m.startedAt, offset)}–${clockTime(end, offset)} (${minutes} min)`
  return `${dateStamp(m.startedAt, offset)}, ${range}`
}

function sources(m: Meeting): string {
  if (m.segments.length === 0) return ''
  return m.segments.some(s => s.meeting) ? ' · recorded: mic + call audio' : ' · recorded: mic'
}

export function renderNotes(m: Meeting, offset: number): string {
  const notes = m.notes.length === 0
    ? '_No notes._'
    : m.notes.map(n => `- **${clockTime(n.at, offset)}** ${n.text}`).join('\n')
  const parts = [`# ${m.title}`, `${span(m, offset)}${sources(m)}`]
  if (m.summary) parts.push(`## Summary\n\n${m.summary}`)
  parts.push(`## Notes\n\n${notes}`)
  if (m.isTranscribed) parts.push('## Transcript\n\n[transcript.md](transcript.md)')
  return `${parts.join('\n\n')}\n`
}

/** Consecutive lines of one speaker become one paragraph. */
export function renderTranscript(m: Meeting, lines: readonly Line[], offset: number): string {
  const paragraphs: { at: number; speaker?: string; texts: string[]; last: number }[] = []
  for (const line of lines) {
    const open = paragraphs.at(-1)
    if (open && open.speaker === line.speaker && line.at - open.last < 30_000) {
      open.texts.push(line.text)
      open.last = line.at
    } else {
      paragraphs.push({ at: line.at, texts: [line.text], last: line.at, ...(line.speaker ? { speaker: line.speaker } : {}) })
    }
  }
  const body = paragraphs.length === 0
    ? '_Nothing was recognised in the recording._'
    : paragraphs
        .map(p => `[${clockTime(p.at, offset, true)}] ${p.speaker ? `**${p.speaker}:** ` : ''}${p.texts.join(' ')}`)
        .join('\n\n')
  return `# Transcript: ${m.title}\n\n${span(m, offset)}\n\n${body}\n`
}

const SYSTEM = `You turn a meeting's raw material into concise minutes.

You get the note-taker's own timestamped notes and, when the meeting was recorded, an automatic transcript. In the transcript "Me" is the note-taker (their microphone) and "Others" is everyone heard through the call audio, possibly several people; an unlabelled line could be anyone. The transcript has recognition errors: where it disagrees with the notes, trust the notes, and never invent names, numbers, dates or commitments.

Write in the language most of the meeting was held in. Answer in Markdown with exactly these parts, in this order, leaving out any part that would be empty:

**TL;DR** two or three sentences.

### Decisions

### Action items
As a checklist: "- [ ] Who: what (by when)", where Who is "Me", a name stated in the meeting, or "?".

### Open questions

### Discussion
The main points as short bullets.

Add no title and no text before **TL;DR**.`

export function summaryRequest(m: Meeting, offset: number, transcript: string): { system: string; prompt: string } {
  const notes = m.notes.length === 0
    ? '(none)'
    : m.notes.map(n => `${clockTime(n.at, offset)} ${n.text}`).join('\n')
  const heard = transcript.trim() === '' ? '(not recorded)' : transcript.slice(0, 600_000)
  const prompt = [
    `Meeting: ${m.title}`,
    `When: ${span(m, offset)}`,
    `<notes>\n${notes}\n</notes>`,
    `<transcript>\n${heard}\n</transcript>`,
  ].join('\n\n')
  return { system: SYSTEM, prompt }
}
