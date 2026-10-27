// Records everything this Mac plays, for the meeting-notes mod.
//
//   system-audio <out.pcm>
//
// Writes 16 kHz mono signed 16-bit PCM to <out.pcm> through a Core Audio
// process tap (macOS 14.2 or later) and prints "level <dB>" once a second.
// It stops on SIGTERM or SIGINT, or when the process that started it ends.
//
// macOS asks the responsible process for permission, and whatever Claude Code
// starts is Claude Code's, whose bundle declares no system-audio use. So the
// helper first starts itself again with responsibility disclaimed: that copy
// answers for itself, under this bundle's NSAudioCaptureUsageDescription.

import AVFoundation
import CoreAudio
import Darwin
import Foundation

struct Failure: Error, CustomStringConvertible {
    let description: String
}

func check(_ status: OSStatus, _ what: String) throws {
    if status != noErr { throw Failure(description: "could not \(what) (OSStatus \(status))") }
}

func address(_ selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(
        mSelector: selector,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain)
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("system-audio: \(message)\n".utf8))
    exit(1)
}

// MARK: Relaunching with responsibility disclaimed

let childMarker = "MEETING_NOTES_AUDIO_CHILD"
var relays: [DispatchSourceSignal] = []

func cStrings(_ strings: [String]) -> [UnsafeMutablePointer<CChar>?] {
    strings.map { strdup($0) } + [nil]
}

/// Starts this program again as its own responsible process and relays
/// signals to it and its exit status back; returns only where that cannot be
/// done, and the recording then runs in this process.
func relaunchDisclaimed() {
    guard ProcessInfo.processInfo.environment[childMarker] == nil,
          let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "responsibility_spawnattrs_setdisclaim"),
          let path = Bundle.main.executablePath
    else { return }
    typealias SetDisclaim = @convention(c) (UnsafeMutablePointer<posix_spawnattr_t?>, Int32) -> Int32
    let setDisclaim = unsafeBitCast(symbol, to: SetDisclaim.self)

    var attributes: posix_spawnattr_t?
    posix_spawnattr_init(&attributes)
    guard setDisclaim(&attributes, 1) == 0 else {
        posix_spawnattr_destroy(&attributes)
        return
    }
    var environment = ProcessInfo.processInfo.environment
    environment[childMarker] = "1"
    let argv = cStrings([path] + CommandLine.arguments.dropFirst())
    let envp = cStrings(environment.map { "\($0.key)=\($0.value)" })
    var child: pid_t = 0
    let spawned = posix_spawn(&child, path, nil, &attributes, argv, envp)
    posix_spawnattr_destroy(&attributes)
    (argv + envp).forEach { free($0) }
    guard spawned == 0 else { return }

    for signalNumber in [SIGTERM, SIGINT] {
        signal(signalNumber, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .main)
        source.setEventHandler { kill(child, signalNumber) }
        source.resume()
        relays.append(source)
    }
    DispatchQueue.global().async {
        var status: Int32 = 0
        while waitpid(child, &status, 0) == -1 && errno == EINTR {}
        exit(status & 0x7f == 0 ? (status >> 8) & 0xff : 1)
    }
    dispatchMain()
}

// MARK: Recording

func defaultOutputUID() throws -> String {
    var device = AudioObjectID(kAudioObjectUnknown)
    var size = UInt32(MemoryLayout<AudioObjectID>.size)
    var deviceAddress = address(kAudioHardwarePropertyDefaultSystemOutputDevice)
    try check(
        AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &deviceAddress, 0, nil, &size, &device),
        "find the output device")
    var uid: Unmanaged<CFString>?
    size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    var uidAddress = address(kAudioDevicePropertyDeviceUID)
    try check(AudioObjectGetPropertyData(device, &uidAddress, 0, nil, &size, &uid), "read the output device's id")
    guard let uid else { throw Failure(description: "the output device has no id") }
    return uid.takeRetainedValue() as String
}

final class TapRecorder {
    private let queue = DispatchQueue(label: "meeting-notes.system-audio")
    private let file: FileHandle
    private let parent = getppid()
    private let output = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true)!
    private var input: AVAudioFormat?
    private var converter: AVAudioConverter?
    private var tap = AudioObjectID(kAudioObjectUnknown)
    private var aggregate = AudioObjectID(kAudioObjectUnknown)
    private var proc: AudioDeviceIOProcID?
    private var timer: DispatchSourceTimer?
    private let lock = NSLock()
    private var peak: Float = 0

    init(file: FileHandle) {
        self.file = file
    }

    func start() throws {
        let description = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
        description.name = "Meeting Notes"
        description.isPrivate = true
        description.muteBehavior = .unmuted
        try check(AudioHardwareCreateProcessTap(description, &tap), "create the system audio tap")

        let outputUID = try defaultOutputUID()
        let settings: [String: Any] = [
            kAudioAggregateDeviceNameKey: "Meeting Notes Audio",
            kAudioAggregateDeviceUIDKey: UUID().uuidString,
            kAudioAggregateDeviceMainSubDeviceKey: outputUID,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outputUID]],
            kAudioAggregateDeviceTapListKey: [
                [kAudioSubTapDriftCompensationKey: true, kAudioSubTapUIDKey: description.uuid.uuidString],
            ],
        ]
        try check(AudioHardwareCreateAggregateDevice(settings as CFDictionary, &aggregate), "create the capture device")

        var format = AudioStreamBasicDescription()
        var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        var formatAddress = address(kAudioTapPropertyFormat)
        try check(AudioObjectGetPropertyData(tap, &formatAddress, 0, nil, &size, &format), "read the tap's format")
        guard let input = AVAudioFormat(streamDescription: &format),
              let converter = AVAudioConverter(from: input, to: output)
        else { throw Failure(description: "cannot convert the tap's audio format") }
        converter.downmix = true
        self.input = input
        self.converter = converter

        try check(
            AudioDeviceCreateIOProcIDWithBlock(&proc, aggregate, queue) { [weak self] _, data, _, _, _ in
                self?.write(data)
            },
            "attach to the capture device")
        try check(AudioDeviceStart(aggregate, proc), "start capturing")

        // The main queue, not the audio one: the beat goes on while macOS
        // holds the audio back, say behind its permission prompt.
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now() + 1, repeating: 1)
        timer.setEventHandler { [weak self] in self?.report() }
        timer.resume()
        self.timer = timer
    }

    /// Ends the recording and the process; run on the main queue.
    func finish() -> Never {
        timer?.cancel()
        if let proc {
            AudioDeviceStop(aggregate, proc)
            AudioDeviceDestroyIOProcID(aggregate, proc)
        }
        AudioHardwareDestroyAggregateDevice(aggregate)
        AudioHardwareDestroyProcessTap(tap)
        queue.sync {}
        try? file.close()
        exit(0)
    }

    private func write(_ data: UnsafePointer<AudioBufferList>) {
        guard let input, let converter,
              let buffer = AVAudioPCMBuffer(pcmFormat: input, bufferListNoCopy: data, deallocator: nil),
              buffer.frameLength > 0
        else { return }
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * output.sampleRate / input.sampleRate) + 64
        guard let converted = AVAudioPCMBuffer(pcmFormat: output, frameCapacity: capacity) else { return }
        var isFed = false
        var error: NSError?
        converter.convert(to: converted, error: &error) { _, status in
            if isFed {
                status.pointee = .noDataNow
                return nil
            }
            isFed = true
            status.pointee = .haveData
            return buffer
        }
        guard error == nil, converted.frameLength > 0, let samples = converted.int16ChannelData?[0] else { return }
        let count = Int(converted.frameLength)
        var loudest: Float = 0
        for i in 0..<count { loudest = max(loudest, abs(Float(samples[i]))) }
        lock.withLock { peak = max(peak, loudest) }
        file.write(Data(bytes: samples, count: count * MemoryLayout<Int16>.size))
    }

    // The level line is also the mod's heartbeat: it notices a stop on it.
    private func report() {
        let loudest = lock.withLock { () -> Float in
            defer { peak = 0 }
            return peak
        }
        let db = loudest > 0 ? max(-91, 20 * log10(loudest / 32_768)) : -91
        print(String(format: "level %.1f", db))
        fflush(stdout)
        if getppid() != parent { finish() }
    }
}

// MARK: Main

setvbuf(stdout, nil, _IOLBF, 0)
guard CommandLine.arguments.count == 2 else {
    FileHandle.standardError.write(Data("usage: system-audio <out.pcm>\n".utf8))
    exit(64)
}
relaunchDisclaimed()

let path = CommandLine.arguments[1]
guard FileManager.default.createFile(atPath: path, contents: nil),
      let file = FileHandle(forWritingAtPath: path)
else { fail("cannot write \(path)") }

let recorder = TapRecorder(file: file)
do {
    try recorder.start()
} catch {
    fail("\(error)")
}
var stops: [DispatchSourceSignal] = []
for signalNumber in [SIGTERM, SIGINT] {
    signal(signalNumber, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .main)
    source.setEventHandler { recorder.finish() }
    source.resume()
    stops.append(source)
}
dispatchMain()
