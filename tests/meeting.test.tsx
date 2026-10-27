import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const PANE = {
  plugin: 'meeting-notes',
  component: 'Pane',
  requestId: 'meeting-notes',
  props: {
    title: 'Meeting',
    isFocused: true,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

// 09:00 local time at +0100.
const START = Date.UTC(2026, 9, 27, 8, 0, 0)
const DIR = '/Users/test/Documents/Meeting Notes/2026-10-27 0900 Weekly sync'

// What the person typing `/meeting <args>` at the prompt raises.
const typed = (args: string) => ({
  command: 'meeting',
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: true, columns: 120 },
})

const HOST_OUTPUT: Record<string, string> = {
  '/bin/date': '+0100\n',
  '/usr/bin/uname': 'Darwin\n',
  '/usr/bin/sw_vers': '27.0.1\n',
}

// Nothing sits beneath the plugin: each hook here stands for the engine.
function world(on: On, os = 'Darwin') {
  const files = new Map<string, string>()
  const prompts: string[] = []
  const clock = mock.clock(on, { now: START })
  mock.store(on)
  mock.env(on, { HOME: '/Users/test' })
  on('command.register', () => ({ value: { command: 'meeting' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  // The system-audio helper counts as built; no tool is found in Homebrew.
  on('fs.exists', (_, e) => ({ value: e.path.endsWith('/.ok') }))
  on('fs.read', (_, e) => ({ value: `contents of ${e.path}` }))
  on('fs.write', (_, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('process.run', (_, e) => ({
    value: {
      exitCode: 0,
      stdout: e.argv[0] === '/usr/bin/uname' ? `${os}\n` : (HOST_OUTPUT[e.argv[0] ?? ''] ?? ''),
      stderr: e.argv.includes('-list_devices')
        ? '[AVFoundation indev @ 0x1] AVFoundation audio devices:\n[AVFoundation indev @ 0x1] [0] Studio Mic\n'
        : '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  on('model.complete', (_, e) => {
    prompts.push(e.prompt)
    return {
      value: {
        isAnswered: true,
        text: '**TL;DR** Ship on Friday.',
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    }
  })

  return { clock, files, prompts }
}

test('notes typed in the pane land in notes.md on every surface with a field', async ($, on) => {
  const { files } = world(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run(typed('start Weekly sync'))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /Weekly sync/ }))?.text).toBe('Weekly sync')
    await ui.input({ key: 'note', text: `decided on ${surface}` })
    expect((await ui.find({ type: 'Text', text: new RegExp(`decided on ${surface}`) }))?.text).toBe(
      `09:00 decided on ${surface}`,
    )
    await ui.unmount()
  }

  const notes = files.get(`${DIR}/notes.md`) ?? ''
  expect(notes).toContain('# Weekly sync')
  expect(notes).toContain('- **09:00** decided on terminal')
  expect(notes).toContain('- **09:00** decided on desktop')
})

test('mobile shows the meeting without a text field', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/', surface: 'mobile', isInteractive: true })
  await $.command.run(typed('start Weekly sync'))

  const ui = await $.ui.mount({ ...PANE, surface: 'mobile' })
  expect((await ui.find({ type: 'Text', text: /Weekly sync/ }))?.text).toBe('Weekly sync')
  expect(await ui.find({ key: 'note' })).toBeUndefined()
  expect(await ui.find({ key: 'stop' })).toBeDefined()
  await ui.unmount()
})

test('recording runs the mic and the system-audio helper, and pausing stops both', async ($, on) => {
  const { clock } = world(on)
  const spawned: string[] = []
  // Each child beats once a second: the helper with its level, ffmpeg with progress.
  on('process.spawn', async function* ($, e) {
    const name = e.argv[0]?.split('/').pop() ?? ''
    spawned.push(name)
    for (;;) {
      yield { stream: 'stdout' as const, text: name === 'system-audio' ? 'level -12.0\n' : 'progress=continue\n' }
      await $.clock.sleep(1000)
    }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run(typed('record Weekly sync'))
  await clock.settle()

  expect(spawned).toEqual(['ffmpeg', 'system-audio'])
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /call/ }))?.text).toBe('mic … · call -12 dB')
  expect(await ui.find({ key: 'pause' })).toBeDefined()

  await ui.press({ key: 'pause' })
  await clock.advance(1500)
  expect(await ui.find({ key: 'record' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /REC/ })).toBeUndefined()
  await ui.unmount()
})

test('setup names what is missing with the command that fixes it', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const { text = '' } = await $.command.run(typed('setup'))

  expect(text).toContain('✓ macOS 27.0.1')
  expect(text).toContain('✓ ffmpeg')
  expect(text).toContain('✓ Call audio helper')
  expect(text).toContain('✗ Whisper model: curl -L --create-dirs -o ~/.cache/whisper/ggml-large-v3-turbo-q5_0.bin')

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /Setup incomplete/ }))?.text).toBe(
    'Setup incomplete (Whisper model): run /meeting setup.',
  )
  await ui.unmount()
})

test('outside macOS the mod says it is macOS only', async ($, on) => {
  world(on, 'Linux')
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const { text = '' } = await $.command.run(typed('record Weekly sync'))

  expect(text).toMatch(/macOS only/)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /macOS only/ }))?.text).toMatch(/macOS only/)
  await ui.unmount()
})

test('stopping a meeting without a recording summarizes the notes', async ($, on) => {
  const { clock, files, prompts } = world(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run(typed('start Weekly sync'))
  await $.command.run(typed('note Ship on Friday'))
  await clock.advance(45 * 60_000)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'stop' })
  await clock.settle()

  expect(prompts[0]).toContain('09:00 Ship on Friday')
  expect(prompts[0]).toContain('(not recorded)')
  const notes = files.get(`${DIR}/notes.md`) ?? ''
  expect(notes).toContain('09:00–09:45 (45 min)')
  expect(notes).toContain('## Summary\n\n**TL;DR** Ship on Friday.')
  expect((await ui.find({ key: 'summary' }))?.props.text).toBe('**TL;DR** Ship on Friday.')
  expect(await ui.find({ key: 'chat' })).toBeDefined()
  await ui.unmount()
})
