# meeting-notes

> **macOS only** (macOS 14.2 or later). It records through macOS audio APIs and does not run on Linux or Windows.

A Claude Code mod for taking notes during a meeting. Open the Meeting pane with `/meeting`, type notes into it (each one is timestamped and saved at once), optionally record, and press **Stop & summarize**. The recording is transcribed on your Mac with whisper.cpp, and Claude writes a summary with decisions, action items and open questions.

It records two things side by side: your microphone and everything the Mac plays, so the other people in a Teams, Zoom or browser call are captured too. The transcript labels them **Me** and **Others**.

## Install

At the prompt of a terminal session:

```
/plugin install meeting-notes --marketplace dariuszparys/claude-meeting-notes
```

From a shell:

```bash
claude plugin install meeting-notes --marketplace dariuszparys/claude-meeting-notes
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `dariuszparys/claude-meeting-notes`, then Add plugin.

## Setup

The mod needs a few tools on your Mac. Run `/meeting setup` after installing: it checks each one and prints the exact command for anything missing. On a fresh Mac with [Homebrew](https://brew.sh) that comes down to:

```bash
xcode-select --install
brew install ffmpeg whisper-cpp
curl -L --create-dirs -o ~/.cache/whisper/ggml-large-v3-turbo-q5_0.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin
```

| Needs | For |
| --- | --- |
| Xcode command line tools | Building the call-audio helper (the mod does it for you, once) |
| `ffmpeg` | Recording the microphone and converting audio |
| `whisper-cli` (whisper-cpp) | The local transcript |
| A whisper.cpp model, about 570 MB | Recognising speech; large-v3-turbo handles German, English and many more |

Your first recording asks for two permissions: the microphone, and **Meeting Notes Audio** recording system audio. You can change both later under System Settings › Privacy & Security.

## Use

| Command | Does |
| --- | --- |
| `/meeting` | Opens the pane |
| `/meeting start [title]` | Starts a meeting without recording |
| `/meeting record [title]` | Starts recording, or starts a meeting with recording |
| `/meeting pause` | Pauses the recording |
| `/meeting note <text>` | Adds a note |
| `/meeting stop` | Stops, transcribes and summarizes |
| `/meeting resume` | Reopens a meeting that a closed session left unfinished |
| `/meeting setup` | Checks the tools and prints what is missing |

Each meeting gets a folder in `~/Documents/Meeting Notes/`:

| File | Holds |
| --- | --- |
| `notes.md` | Summary, your notes, a link to the transcript |
| `transcript.md` | The transcript, `Me` (your mic) and `Others` (the call) labelled |
| `audio.m4a` | The recording: mic left, call right (turn off with Keep audio) |

While recording, the pane shows the live level of each input, and a hint when one stays silent. Transcription runs on your Mac; only your notes and the transcript text go to Claude for the summary.

## How the call audio is recorded

The call's audio comes from `helper/system-audio.swift`, a small helper that records everything the Mac plays through a Core Audio process tap. It needs no driver and no audio routing.

The mod ships the helper as source, not as a binary. On first use it compiles it with `swiftc`, signs it locally (ad hoc), and keeps the build in `~/.cache/meeting-notes/`. It rebuilds only when the source changes, and macOS asks for the permission again after a rebuild.

macOS asks the process responsible for a recording, and anything Claude Code starts counts as Claude Code. So the helper starts itself again as its own responsible process. That uses an undocumented macOS call, `responsibility_spawnattrs_setdisclaim`.

It records all system sound while the meeting runs, notification sounds included. To use a loopback device such as BlackHole instead, set Call audio to `device`. Set it to `off` to record the microphone only.

## Settings

Notes folder, microphone, call audio (`system`, `device` or `off`), call audio device, Whisper model, spoken language (`auto`, `de`, `en`, ...), summary model (`sonnet` by default) and Keep audio are rows in `/config` under meeting-notes.

## License

MIT, see [LICENSE](LICENSE).
