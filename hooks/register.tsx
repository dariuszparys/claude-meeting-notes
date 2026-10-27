import { atom, read, update } from 'claude-code'
import type {
  EngineInterface,
  HookStream,
  PluginOptions,
  ProcessSpawnChunk,
  ProcessSpawnResult,
  Register,
} from 'claude-code'

import type { CallSource, Levels, Meeting, Segment } from '../types'
import {
  SILENT_DB,
  clockTime,
  elapsed,
  expandHome,
  folderName,
  levelLabel,
  parseAudioDevices,
  parseHelperLevel,
  parseLevel,
  parseOffset,
  parseWhisperLine,
  renderNotes,
  renderTranscript,
  sha256,
  summaryRequest,
} from './meeting'
import type { Line } from './meeting'

type $ = EngineInterface
type Source = 'mic' | 'meeting'
type Recorder = {
  stream: HookStream<ProcessSpawnChunk, ProcessSpawnResult>
  isStopping: boolean
  ended: Promise<void>
}
type Wav = { path: string; isStereo: boolean; seconds: number }
type Config = {
  notesDir: string
  micDevice: string
  callAudio: CallSource | 'off'
  meetingDevice: string
  whisperModel: string
  language: string
  summaryModel: string
  keepAudio: boolean
}

const PANE = 'meeting-notes'
const meeting = atom({ plugin: 'meeting-notes', key: 'meeting' } as const, null)
const levels = atom({ plugin: 'meeting-notes', key: 'levels' } as const, null)
const now = atom({ plugin: 'meeting-notes', key: 'now' } as const, 0)
const missing = atom({ plugin: 'meeting-notes', key: 'missing' } as const, null)

const MAC_ONLY = 'meeting-notes works on macOS only: it records through macOS audio APIs.'
const DEFAULT_MODEL = '~/.cache/whisper/ggml-large-v3-turbo-q5_0.bin'
const MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin'

const QUIET = ['-hide_banner', '-nostdin', '-loglevel', 'error']
const RAW = ['-f', 's16le', '-ar', '16000', '-ch_layout', 'mono']
const BYTES_PER_SECOND = 32_000
const USAGE =
  'Usage: /meeting [start [title] | record [title] | pause | note <text> | stop | resume | setup]'

function loadConfig(options: PluginOptions, home: string): Config {
  const text = (key: string, fallback: string): string => {
    const value = options[key]
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
  }
  const callAudio = text('callAudio', 'system')
  return {
    notesDir: expandHome(text('notesDir', '~/Documents/Meeting Notes'), home),
    micDevice: text('micDevice', 'default'),
    callAudio: callAudio === 'device' || callAudio === 'off' ? callAudio : 'system',
    meetingDevice: text('meetingDevice', 'BlackHole 2ch'),
    whisperModel: expandHome(text('whisperModel', DEFAULT_MODEL), home),
    language: text('language', 'auto'),
    summaryModel: text('summaryModel', 'sonnet'),
    keepAudio: options.keepAudio !== false,
  }
}

const unique = (items: readonly string[]): string[] => [...new Set(items)]

function closeSegments(m: Meeting, endedAt: number): Meeting {
  return {
    ...m,
    isRecording: false,
    segments: m.segments.map(s => (s.endedAt === undefined ? { ...s, endedAt } : s)),
  }
}

// The module's own variables start over on every reload; what must survive
// one lives in $.state.
const ctx = {
  config: loadConfig({}, ''),
  isMac: false,
  home: '',
  offset: 0,
  ffmpeg: 'ffmpeg',
  whisper: 'whisper-cli',
  helper: undefined as Promise<string> | undefined,
  titleDraft: '',
  isFinishing: false,
  ticks: 0,
}
const recorders = new Map<Source, Recorder>()

// The system-audio helper ships as Swift source and is built on this Mac,
// once per version of that source; macOS keys its permission to the build.
async function buildHelper($: $): Promise<string> {
  const tools = await $.process.run(['/usr/bin/xcode-select', '-p']).catch(() => undefined)
  if (tools?.exitCode !== 0) {
    throw new Error('install the Xcode command line tools: xcode-select --install')
  }
  const source = `${$.plugin.root}/helper/system-audio.swift`
  const plist = await $.fs.read(`${$.plugin.root}/helper/Info.plist`)
  const swift = await $.fs.read(source)
  const hash = (await sha256(swift + plist)).slice(0, 12)
  const dir = `${ctx.home}/.cache/meeting-notes/system-audio-${hash}`
  const app = `${dir}/MeetingNotesAudio.app`
  const exe = `${app}/Contents/MacOS/system-audio`
  if (await $.fs.exists(`${dir}/.ok`)) return exe
  await $.fs.write(`${app}/Contents/Info.plist`, plist)
  await mustRun($, ['/bin/mkdir', '-p', `${app}/Contents/MacOS`])
  await mustRun($, ['/usr/bin/xcrun', 'swiftc', '-O', '-swift-version', '5', '-o', exe, source])
  await mustRun($, ['/usr/bin/codesign', '--force', '--sign', '-', app])
  await $.fs.write(`${dir}/.ok`, '')

  return exe
}

function systemAudioHelper($: $): Promise<string> {
  ctx.helper ??= buildHelper($).catch((err: unknown) => {
    ctx.helper = undefined
    throw err
  })
  return ctx.helper
}

type Check = { name: string; isOk: boolean; fix: string }

async function isInstalled($: $, tool: string): Promise<boolean> {
  if (tool.startsWith('/')) return true
  const found = await $.process.run(['/usr/bin/which', tool]).catch(() => undefined)
  return found?.exitCode === 0
}

// Everything a recording needs, each with the one step that fixes it.
async function checkSetup($: $): Promise<Check[]> {
  const sw = await $.process.run(['/usr/bin/sw_vers', '-productVersion']).catch(() => undefined)
  const version = sw?.stdout.trim() ?? ''
  const [major = 0, minor = 0] = version.split('.').map(Number)
  const model = ctx.config.whisperModel
  const isDefaultModel = model === expandHome(DEFAULT_MODEL, ctx.home)
  const checks: Check[] = [
    {
      name: `macOS ${version || 'version'}`,
      isOk: major > 14 || (major === 14 && minor >= 2),
      fix: 'Recording the call needs macOS 14.2 or later.',
    },
    { name: 'ffmpeg', isOk: await isInstalled($, ctx.ffmpeg), fix: 'brew install ffmpeg' },
    { name: 'whisper-cli', isOk: await isInstalled($, ctx.whisper), fix: 'brew install whisper-cpp' },
    {
      name: 'Whisper model',
      isOk: await $.fs.exists(model),
      fix: isDefaultModel
        ? `curl -L --create-dirs -o ${DEFAULT_MODEL} ${MODEL_URL}   (about 570 MB)`
        : `No file at ${model}: set Whisper model in /config.`,
    },
  ]
  if (ctx.config.callAudio === 'system') {
    const helper = await systemAudioHelper($).then(
      () => '',
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    )
    checks.push({ name: 'Call audio helper', isOk: helper === '', fix: helper })
  }

  return checks
}

async function refreshSetup($: $): Promise<Check[]> {
  const checks = await checkSetup($)
  await update($, missing, () => checks.filter(c => !c.isOk).map(c => c.name))
  return checks
}

function ffmpegRecording(device: string, file: string): string[] {
  return [
    ctx.ffmpeg, ...QUIET, '-nostats', '-progress', 'pipe:1', '-stats_period', '1',
    '-f', 'avfoundation', '-i', `:${device}`,
    '-ac', '1', '-ar', '16000', '-f', 's16le', '-y', file,
  ]
}

function run($: $, work: () => Promise<unknown>): void {
  void work().catch((err: unknown) => {
    $.ui.toast(`Meeting notes: ${err instanceof Error ? err.message : String(err)}`)
  })
}

async function findTool($: $, name: string): Promise<string> {
  for (const dir of ['/opt/homebrew/bin', '/usr/local/bin']) {
    if (await $.fs.exists(`${dir}/${name}`)) return `${dir}/${name}`
  }
  return name
}

async function mustRun($: $, argv: string[]): Promise<void> {
  const result = await $.process.run(argv, { timeoutMs: 600_000 })
  if (result.exitCode !== 0) {
    const tail = result.stderr.trim().split('\n').slice(-2).join(' ')
    throw new Error(`${argv[0]?.split('/').pop()} failed: ${tail || `exit ${result.exitCode}`}`)
  }
}

async function readOffset($: $): Promise<void> {
  const result = await $.process.run(['/bin/date', '+%z']).catch(() => undefined)
  ctx.offset = parseOffset(result?.stdout ?? '')
}

// Every change that matters lands on disk at once, so a crash loses nothing.
async function save($: $, change: (m: Meeting) => Meeting): Promise<Meeting | null> {
  const m = await update($, meeting, current => (current ? change(current) : current))
  if (m) {
    await $.fs.write(`${m.dir}/notes.md`, renderNotes(m, ctx.offset))
    await $.fs.write(`${m.dir}/.meeting.json`, JSON.stringify(m, null, 2))
  }
  return m
}

async function setStep($: $, step: string): Promise<void> {
  await update($, meeting, m => (m ? { ...m, step } : m))
  $.ui.status(`Meeting: ${step}`)
}

async function openPane($: $): Promise<void> {
  await $.ui.open({ id: PANE, title: 'Meeting' })
}

async function startMeeting($: $, title: string, isRecorded: boolean): Promise<Meeting> {
  const current = await read($, meeting)
  if (current?.phase === 'live' || current?.phase === 'processing') return current
  await readOffset($)
  const startedAt = await $.clock.now()
  const name = title.trim() || 'Meeting'
  const m: Meeting = {
    title: name,
    dir: `${ctx.config.notesDir}/${folderName(startedAt, ctx.offset, name)}`,
    startedAt,
    notes: [],
    segments: [],
    isRecording: false,
    isTranscribed: false,
    phase: 'live',
    warnings: [],
  }
  await update($, meeting, () => m)
  await update($, levels, () => null)
  await update($, now, () => startedAt)
  await save($, x => x)
  await $.store.set('active', m.dir)
  ctx.titleDraft = ''
  if (isRecorded) await startRecording($)

  return (await read($, meeting)) ?? m
}

function spawnRecorder($: $, source: Source, argv: string[]): void {
  const stream = $.process.spawn({ argv })
  const recorder: Recorder = { stream, isStopping: false, ended: Promise.resolve() }
  recorder.ended = (async () => {
    let errors = ''
    try {
      // ffmpeg's progress report and the helper's level line arrive every
      // second, so a stop is seen even in silence; leaving the loop ends the child.
      for await (const chunk of stream) {
        if (recorder.isStopping) break
        if (chunk.stream === 'stderr') {
          errors = (errors + chunk.text).slice(-400)
          continue
        }
        const db = parseHelperLevel(chunk.text)
        if (db !== undefined) {
          await update($, levels, current => ({ ...current, meeting: db, ...(db > SILENT_DB ? { isCallHeard: true } : {}) }))
        }
      }
    } catch (err) {
      errors += ` ${String(err)}`
    }
    if (!recorder.isStopping && recorders.get(source) === recorder) {
      recorders.delete(source)
      const why = `The ${source} recording stopped: ${errors.trim() || 'ffmpeg exited'}`
      await save($, m => ({ ...m, warnings: unique([...m.warnings, why]) }))
      $.ui.toast(`Meeting notes: the ${source} recording stopped`)
    }
  })()
  recorders.set(source, recorder)
}

async function startRecording($: $): Promise<void> {
  const m = await read($, meeting)
  if (!m || m.phase !== 'live' || m.isRecording) return
  const listing = await $.process.run([
    ctx.ffmpeg, '-hide_banner', '-nostdin', '-f', 'avfoundation', '-list_devices', 'true', '-i', '',
  ])
  const devices = parseAudioDevices(listing.stderr)
  const warnings: string[] = []
  let mic = ctx.config.micDevice
  if (mic !== 'default' && !devices.includes(mic)) {
    warnings.push(`Microphone "${mic}" was not found, so the system input is recorded.`)
    mic = 'default'
  }
  // Both sources start together, so the call's source is settled first.
  let call: CallSource | undefined
  let helper = ''
  if (ctx.config.callAudio === 'system') {
    try {
      helper = await systemAudioHelper($)
      call = 'system'
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err)
      warnings.push(`Only the microphone is recorded; for the call's audio, ${why}.`)
    }
  } else if (ctx.config.callAudio === 'device') {
    if (devices.includes(ctx.config.meetingDevice)) call = 'device'
    else warnings.push(`"${ctx.config.meetingDevice}" was not found, so only the microphone is recorded.`)
  }
  const index = m.segments.length + 1
  const segment: Segment = {
    startedAt: await $.clock.now(),
    mic: `${m.dir}/.rec/${index}-mic.pcm`,
    ...(call ? { meeting: `${m.dir}/.rec/${index}-call.pcm`, call } : {}),
  }
  await $.fs.write(`${m.dir}/.rec/README`, 'Raw recording; removed once the transcript is written.\n')
  spawnRecorder($, 'mic', ffmpegRecording(mic, segment.mic))
  if (segment.meeting) {
    const argv = call === 'system' ? [helper, segment.meeting] : ffmpegRecording(ctx.config.meetingDevice, segment.meeting)
    spawnRecorder($, 'meeting', argv)
  }
  await save($, x => ({
    ...x,
    isRecording: true,
    segments: [...x.segments, segment],
    warnings: unique([...x.warnings, ...warnings]),
  }))
}

async function stopRecording($: $): Promise<void> {
  const running = [...recorders.values()]
  recorders.clear()
  for (const recorder of running) recorder.isStopping = true
  const timeout = new AbortController()
  await Promise.race([
    Promise.all(running.map(r => r.ended)),
    $.clock.sleep(4000, { signal: timeout.signal }).catch(() => undefined),
  ])
  timeout.abort()
  for (const recorder of running) {
    void recorder.stream.return({ code: null, signal: null }).catch(() => undefined)
  }
  const endedAt = await $.clock.now()
  await save($, m => closeSegments(m, endedAt))
  await update($, levels, () => null)
}

async function addNote($: $, value: string): Promise<boolean> {
  const said = value.trim()
  const m = await read($, meeting)
  if (said === '' || m?.phase !== 'live') return false
  const at = await $.clock.now()
  await save($, x => ({ ...x, notes: [...x.notes, { at, text: said }] }))

  return true
}

async function stopMeeting($: $): Promise<boolean> {
  const m = await read($, meeting)
  if (m?.phase !== 'live') return false
  if (m.isRecording) await stopRecording($)
  const endedAt = await $.clock.now()
  await save($, x => ({ ...x, phase: 'processing', endedAt, step: 'Starting…' }))
  $.clock.after(0, () => void finish($))

  return true
}

async function retry($: $): Promise<void> {
  const { error: _error, ...rest } = (await read($, meeting)) ?? ({} as Meeting)
  if (rest.phase !== 'failed') return
  await save($, () => ({ ...rest, phase: 'processing', step: 'Starting…' }))
  $.clock.after(0, () => void finish($))
}

async function pcmSeconds($: $, file: string | undefined): Promise<number> {
  if (!file || !(await $.fs.exists(file))) return 0
  return (await $.fs.stat(file)).size / BYTES_PER_SECOND
}

// The mic goes left and the call right, so whisper can tell "Me" from "Others".
async function toWav($: $, segment: Segment, out: string): Promise<Wav | undefined> {
  const mic = await pcmSeconds($, segment.mic)
  const call = await pcmSeconds($, segment.meeting)
  const seconds = Math.max(mic, call)
  if (seconds < 1) return undefined
  if (mic > 0 && call > 0 && segment.meeting) {
    await mustRun($, [
      ctx.ffmpeg, ...QUIET, '-y', ...RAW, '-i', segment.mic, ...RAW, '-i', segment.meeting,
      '-filter_complex', '[0:a]apad[l];[1:a]apad[r];[l][r]join=inputs=2:channel_layout=stereo[a]',
      '-map', '[a]', '-t', seconds.toFixed(2), out,
    ])
    return { path: out, isStereo: true, seconds }
  }
  const only = mic > 0 ? segment.mic : (segment.meeting ?? segment.mic)
  await mustRun($, [ctx.ffmpeg, ...QUIET, '-y', ...RAW, '-i', only, out])

  return { path: out, isStereo: false, seconds }
}

async function transcribe($: $, wav: Wav, startedAt: number, part: string): Promise<Line[]> {
  const total = elapsed(wav.seconds * 1000)
  const lines: Line[] = []
  let pending = ''
  let errors = ''
  const take = (raw: string) => {
    const line = parseWhisperLine(raw, startedAt)
    if (line) lines.push(line)
  }
  await setStep($, `Transcribing${part}…`)
  const stream = $.process.spawn({
    argv: [
      ctx.whisper, '-m', ctx.config.whisperModel, '-l', ctx.config.language, '-np',
      ...(wav.isStereo ? ['-di'] : []), '-f', wav.path,
    ],
  })
  for await (const chunk of stream) {
    if (chunk.stream === 'stderr') {
      errors = (errors + chunk.text).slice(-600)
      continue
    }
    const parts = (pending + chunk.text).split('\n')
    pending = parts.pop() ?? ''
    parts.forEach(take)
    const last = lines.at(-1)
    if (last) await setStep($, `Transcribing${part}… ${elapsed(last.offsetMs)} of ${total}`)
  }
  take(pending)
  const result = await stream.result
  if (result.code !== 0) {
    const tail = errors.trim().split('\n').slice(-2).join(' ')
    throw new Error(`ctx.whisper-cli failed (${result.code ?? result.signal}): ${tail}`)
  }

  return lines
}

async function finish($: $): Promise<void> {
  if (ctx.isFinishing) return
  ctx.isFinishing = true
  try {
    let m = await read($, meeting)
    if (!m || m.phase !== 'processing') return
    let transcript = ''
    if (m.isTranscribed) {
      transcript = await $.fs.read(`${m.dir}/transcript.md`).catch(() => '')
    } else if (m.segments.length > 0) {
      if (!(await $.fs.exists(ctx.config.whisperModel))) {
        throw new Error(`No Whisper model at ${ctx.config.whisperModel}. Run /meeting setup, then press Retry.`)
      }
      const lines: Line[] = []
      for (const [i, segment] of m.segments.entries()) {
        const part = m.segments.length > 1 ? ` ${i + 1}/${m.segments.length}` : ''
        await setStep($, `Preparing audio${part}…`)
        const wav = await toWav($, segment, `${m.dir}/.rec/${i + 1}.wav`)
        if (!wav) continue
        lines.push(...(await transcribe($, wav, segment.startedAt, part)))
        if (ctx.config.keepAudio) {
          await setStep($, `Saving audio${part}…`)
          const name = i === 0 ? 'audio.m4a' : `audio-${i + 1}.m4a`
          await mustRun($, [ctx.ffmpeg, ...QUIET, '-y', '-i', wav.path, '-c:a', 'aac', '-b:a', '64k', `${m.dir}/${name}`])
        }
      }
      transcript = renderTranscript(m, lines, ctx.offset)
      await $.fs.write(`${m.dir}/transcript.md`, transcript)
      m = (await save($, x => ({ ...x, isTranscribed: true }))) ?? m
      await $.process.run(['/bin/rm', '-rf', `${m.dir}/.rec`])
    }
    if (m.notes.length > 0 || m.isTranscribed) {
      await setStep($, 'Writing the summary…')
      const { system, prompt } = summaryRequest(m, ctx.offset, transcript)
      const reply = await $.model.complete({
        model: ctx.config.summaryModel,
        system,
        prompt,
        maxTokens: 4000,
        timeoutMs: 300_000,
      })
      if (!reply.isAnswered) {
        throw new Error(`The summary model gave no answer (${reply.reason}). Press Retry.`)
      }
      await save($, x => ({ ...x, summary: reply.text.trim() }))
    }
    const done = await save($, ({ step: _step, ...x }) => ({ ...x, phase: 'done' }))
    await $.store.delete('active')
    $.ui.status(undefined)
    $.ui.toast(`Meeting summary ready: ${done?.title ?? 'meeting'}`)
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    await save($, ({ step: _step, ...x }) => ({ ...x, phase: 'failed', error }))
    $.ui.status(undefined)
    $.ui.toast(`Meeting notes: ${error}`)
  } finally {
    ctx.isFinishing = false
  }
}

async function resume($: $): Promise<string> {
  const current = await read($, meeting)
  if (current?.phase === 'live' || current?.phase === 'processing') {
    return `"${current.title}" is already open.`
  }
  const dir = await $.store.get('active')
  if (typeof dir !== 'string') return 'There is no unfinished meeting to resume.'
  const saved = await $.fs.read(`${dir}/.meeting.json`).catch(() => undefined)
  if (typeof saved !== 'string') return `Nothing to resume at ${dir}.`
  const m = JSON.parse(saved) as Meeting
  await readOffset($)
  // An open segment ended with the old session: its file says how long it ran.
  const segments: Segment[] = []
  for (const s of m.segments) {
    const seconds = Math.max(await pcmSeconds($, s.mic), await pcmSeconds($, s.meeting))
    segments.push(s.endedAt === undefined ? { ...s, endedAt: s.startedAt + seconds * 1000 } : s)
  }
  const isFinishable = m.phase === 'processing' || m.phase === 'failed'
  const { error: _error, step: _step, ...rest } = m
  const restored: Meeting = {
    ...rest,
    segments,
    isRecording: false,
    phase: isFinishable ? 'processing' : 'live',
    ...(isFinishable ? { step: 'Starting…' } : {}),
  }
  await update($, meeting, () => restored)
  await update($, now, () => restored.startedAt)
  if (isFinishable) $.clock.after(0, () => void finish($))

  return `Resumed "${m.title}".`
}

async function tick($: $): Promise<void> {
  const m = await read($, meeting)
  if (m?.phase !== 'live') return
  const t = await $.clock.now()
  await update($, now, () => t)
  $.ui.status(`${m.isRecording ? '● REC' : 'Notes'} ${elapsed(t - m.startedAt)} · ${m.title}`)
  ctx.ticks += 1
  if (m.isRecording && ctx.ticks % 2 === 0) await measure($, m)
}

async function measure($: $, m: Meeting): Promise<void> {
  const segment = m.segments.at(-1)
  if (!segment) return
  const peak = async (file: string | undefined): Promise<number | undefined> => {
    if (!file) return undefined
    const result = await $.process
      .run(
        [ctx.ffmpeg, '-hide_banner', '-nostdin', '-sseof', '-3', ...RAW, '-i', file, '-af', 'volumedetect', '-f', 'null', '-'],
        { timeoutMs: 10_000 },
      )
      .catch(() => undefined)
    return result ? parseLevel(result.stderr) : undefined
  }
  // The helper reports its own level on every beat.
  const callFile = segment.call === 'system' ? undefined : segment.meeting
  const [mic, call] = await Promise.all([peak(segment.mic), peak(callFile)])
  const next: Levels = {}
  if (mic !== undefined) next.mic = mic
  if (call !== undefined) next.meeting = call
  if (call !== undefined && call > SILENT_DB) next.isCallHeard = true
  await update($, levels, current => ({ ...current, ...next }))
}

function describe(m: Meeting): string {
  switch (m.phase) {
    case 'live':
      return `"${m.title}" is running${m.isRecording ? ' and recording' : ''}, ${m.notes.length} notes.`
    case 'processing':
      return `"${m.title}": ${m.step ?? 'working…'}`
    case 'done':
      return `"${m.title}" is done. Notes: ${m.dir}/notes.md`
    case 'failed':
      return `"${m.title}" failed: ${m.error ?? 'unknown error'}`
  }
}


export const register: Register = (on, options) => {
  ctx.config = loadConfig(options, '')

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'meeting',
      description: 'Take meeting notes, optionally record, and get a summary afterwards (macOS)',
      argumentHint: 'start [title] | record [title] | pause | note <text> | stop | resume | setup',
    })
    const os = await $.process.run(['/usr/bin/uname', '-s']).catch(() => undefined)
    ctx.isMac = os?.stdout.trim() === 'Darwin'
    if (!ctx.isMac) return next(e)
    ctx.home = (await $.env.get('HOME')) ?? ''
    ctx.config = loadConfig(options, ctx.home)
    await readOffset($)
    ctx.ffmpeg = await findTool($, 'ffmpeg')
    ctx.whisper = await findTool($, 'whisper-cli')
    // Checked ahead, which also builds the helper before the first recording.
    void refreshSetup($).catch(() => undefined)
    $.clock.every(5000, () => void tick($))
    const m = await read($, meeting)
    if (m?.phase === 'live' && m.isRecording) {
      // A reload ended the old module's recorders: go on in a new segment.
      const endedAt = await $.clock.now()
      await save($, x => closeSegments(x, endedAt))
      await startRecording($)
    }
    if (m?.phase === 'processing') $.clock.after(0, () => void finish($))

    return next(e)
  })

  on('command.run', { command: 'meeting' }, async ($, e) => {
    const args = e.args.trim()
    const verb = (args.split(/\s+/)[0] ?? '').toLowerCase()
    const rest = args.slice(verb.length).trim()
    if (!ctx.isMac) return { text: MAC_ONLY }
    const m = await read($, meeting)
    const isLive = m?.phase === 'live'

    switch (verb) {
      case 'setup': {
        const checks = await refreshSetup($)
        const lines = checks.map(c => (c.isOk ? `✓ ${c.name}` : `✗ ${c.name}: ${c.fix}`))
        const verdict = checks.every(c => c.isOk)
          ? 'Ready. The first recording asks once to let Meeting Notes Audio record system audio.'
          : 'Run the commands above, then /meeting setup again.'
        return { text: ['meeting-notes setup:', ...lines, verdict].join('\n') }
      }
      case '':
        await openPane($)
        return { text: m ? describe(m) : 'Meeting pane opened. Start a meeting there or with /meeting start [title].' }
      case 'start':
      case 'record': {
        if (m && isLive) {
          if (verb === 'record') await startRecording($)
          await openPane($)
          return { text: verb === 'record' ? `Recording "${m.title}".` : `"${m.title}" is already running.` }
        }
        if (m?.phase === 'processing') return { text: describe(m) }
        const started = await startMeeting($, rest, verb === 'record')
        await openPane($)
        return {
          text: `Started "${started.title}"${started.isRecording ? ', recording' : ''}. Notes go to ${started.dir}/notes.md`,
        }
      }
      case 'pause':
        if (!m?.isRecording) return { text: 'Nothing is recording.' }
        await stopRecording($)
        return { text: 'Recording paused; /meeting record resumes it.' }
      case 'note':
        return { text: (await addNote($, rest)) ? 'Noted.' : 'No meeting is running, or the note is empty.' }
      case 'stop':
        if (!(await stopMeeting($))) return { text: 'No meeting is running.' }
        await openPane($)
        return { text: 'Meeting stopped. The transcript and summary are being written; the pane shows progress.' }
      case 'resume': {
        const said = await resume($)
        await openPane($)
        return { text: said }
      }
      default:
        return { text: USAGE }
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Markdown, Text } = $.ui.resolve(e)
    if (!ctx.isMac) return <Text>{MAC_ONLY}</Text>
    const m = await read($, meeting)

    // Mobile draws no text fields; there /meeting note is the way in.
    const Input = e.surface === 'mobile' ? undefined : $.ui.resolve(e).Input

    if (!m) {
      const gaps = await read($, missing)
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold>No meeting running</Text>
          {gaps && gaps.length > 0 && (
            <Text color="warning">Setup incomplete ({gaps.join(', ')}): run /meeting setup.</Text>
          )}
          {Input && (
            <Input
              key="title"
              placeholder="Title (optional)"
              submitLabel="start"
              value=""
              autoFocus
              onInput={value => {
                ctx.titleDraft = value
              }}
              onSubmit={value => run($, () => startMeeting($, value, false))}
            />
          )}
          <Box flexDirection="row" gap={1}>
            <Button key="start" label="Start" onPress={() => run($, () => startMeeting($, ctx.titleDraft, false))} />
            <Button
              key="start-rec"
              variant="primary"
              label="Start + record"
              onPress={() => run($, () => startMeeting($, ctx.titleDraft, true))}
            />
          </Box>
          <Text dimColor>Saved to {ctx.config.notesDir}</Text>
        </Box>
      )
    }

    if (m.phase === 'live') {
      const t = Math.max(await read($, now), m.startedAt)
      const level = await read($, levels)
      const callSource = m.segments.at(-1)?.call
      const isCalled = callSource !== undefined
      const room = Math.max(3, (e.viewport?.rows ?? 30) - 14)
      const isMicSilent = level?.mic !== undefined && level.mic <= SILENT_DB
      // Quiet seconds in a call are normal: hint only until the call was first heard.
      const isCallSilent =
        isCalled && level?.isCallHeard !== true && level?.meeting !== undefined && level.meeting <= SILENT_DB

      return (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="row" justifyContent="space-between">
            <Text bold wrap="truncate-end">
              {m.title}
            </Text>
            <Text>
              {m.isRecording ? <Text color="error">● REC </Text> : null}
              <Text dimColor>{elapsed(t - m.startedAt)}</Text>
            </Text>
          </Box>
          {m.isRecording && (
            <Text dimColor>
              mic {levelLabel(level?.mic)}
              {isCalled ? ` · call ${levelLabel(level?.meeting)}` : ''}
            </Text>
          )}
          {m.isRecording && isMicSilent && <Text color="warning">The mic is silent: check the system input device.</Text>}
          {m.isRecording && isCallSilent && (
            <Text dimColor>
              {callSource === 'system'
                ? 'Nothing is playing yet. If the call is on, allow Meeting Notes Audio under System Settings › Privacy & Security › Screen & System Audio Recording.'
                : "Call audio is silent: route the call's output through the Multi-Output Device."}
            </Text>
          )}
          {m.warnings.map(warning => (
            <Text color="warning">{warning}</Text>
          ))}
          <Box flexDirection="column">
            {m.notes.length === 0 && <Text dimColor>No notes yet.</Text>}
            {m.notes.slice(-room).map(note => (
              <Text>
                <Text dimColor>{clockTime(note.at, ctx.offset)}</Text> {note.text}
              </Text>
            ))}
          </Box>
          {Input && (
            <Input
              key="note"
              placeholder="Type a note, Enter adds it"
              submitLabel="add"
              value=""
              autoFocus
              onSubmit={value => run($, () => addNote($, value))}
            />
          )}
          <Box flexDirection="row" gap={1}>
            {m.isRecording ? (
              <Button key="pause" label="Pause recording" onPress={() => run($, () => stopRecording($))} />
            ) : (
              <Button
                key="record"
                label={m.segments.length > 0 ? 'Resume recording' : 'Record'}
                onPress={() => run($, () => startRecording($))}
              />
            )}
            <Button key="stop" variant="primary" label="Stop & summarize" onPress={() => run($, () => stopMeeting($))} />
          </Box>
        </Box>
      )
    }

    if (m.phase === 'processing') {
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold>{m.title}</Text>
          <Text>{m.step ?? 'Working…'}</Text>
          <Text dimColor>This runs on this Mac; you can keep working. The summary lands in notes.md.</Text>
        </Box>
      )
    }

    const transcriptHint = m.isTranscribed ? ` and the transcript in "${m.dir}/transcript.md"` : ''

    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>{m.title}</Text>
        {m.phase === 'failed' && <Text color="error">{m.error ?? 'Something went wrong.'}</Text>}
        {m.summary ? (
          <Markdown key="summary" text={m.summary} />
        ) : (
          m.phase === 'done' && <Text dimColor>Nothing to summarize: no notes and no recording.</Text>
        )}
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          {m.phase === 'failed' && <Button key="retry" variant="primary" label="Retry" onPress={() => run($, () => retry($))} />}
          <Button key="open" label="Open folder" onPress={() => run($, () => $.process.run(['/usr/bin/open', m.dir]))} />
          {m.phase === 'done' && (
            <Button
              key="chat"
              label="Discuss in chat"
              onPress={() =>
                run($, () =>
                  $.prompt.fill({
                    text: `Read my meeting notes in "${m.dir}/notes.md"${transcriptHint}, then `,
                    mode: 'insert',
                  }),
                )
              }
            />
          )}
          <Button
            key="new"
            variant={m.phase === 'done' ? 'primary' : 'secondary'}
            label="New meeting"
            onPress={() => run($, () => update($, meeting, () => null))}
          />
        </Box>
      </Box>
    )
  })
}
