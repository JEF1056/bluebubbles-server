import AVFoundation
import AudioToolbox
import CoreAudio
import Foundation

// Build: swiftc -O -target arm64-apple-macos14.2 -framework CoreAudio -framework AudioToolbox -framework AVFoundation -framework Foundation scripts/BlueBubblesAudioBridge.swift -o appResources/macos/tools/BlueBubblesAudioBridge
// shortcut: requires BlackHole 2ch selected as FaceTime mic input; upgrade to a custom AudioServerPlugIn only if automatic mic switching is needed.

private let targetBundleIDs: Set<String> = [
    "com.apple.avconferenced",
    "com.apple.FaceTime",
    "com.apple.telephonyutilities.callservicesd",
]

private let sampleRate: Double = 48_000
private let frameSamples: Int = 960 // 20ms @ 48kHz

final class FloatRingBuffer {
    private var buf: [Float]
    private var readIdx = 0
    private var writeIdx = 0
    private var count = 0
    private let lock = NSLock()

    init(capacity: Int = 48_000 * 2) {
        self.buf = [Float](repeating: 0, count: capacity)
    }

    func push(_ samples: UnsafePointer<Float>, length: Int) {
        lock.lock()
        defer { lock.unlock() }
        let cap = buf.count
        for i in 0..<length {
            if count == cap {
                readIdx = (readIdx + 1) % cap
                count -= 1
            }
            buf[writeIdx] = samples[i]
            writeIdx = (writeIdx + 1) % cap
            count += 1
        }
    }

    func pop(into dst: UnsafeMutablePointer<Float>, length: Int) -> Int {
        lock.lock()
        defer { lock.unlock() }
        let n = min(length, count)
        let cap = buf.count
        for i in 0..<n {
            dst[i] = buf[readIdx]
            readIdx = (readIdx + 1) % cap
        }
        count -= n
        return n
    }

    var available: Int {
        lock.lock()
        defer { lock.unlock() }
        return count
    }
}

func getProcessObjectIDs(matching bundleIDs: Set<String>) -> [AudioObjectID] {
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyProcessObjectList,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size) == noErr,
          size > 0 else {
        return []
    }
    let count = Int(size) / MemoryLayout<AudioObjectID>.size
    var ids = [AudioObjectID](repeating: 0, count: count)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &ids) == noErr else {
        return []
    }
    return ids.filter { objID in
        var bAddr = AudioObjectPropertyAddress(
            mSelector: kAudioProcessPropertyBundleID,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var cfStr: Unmanaged<CFString>?
        var bSize = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        guard AudioObjectGetPropertyData(objID, &bAddr, 0, nil, &bSize, &cfStr) == noErr,
              let bid = cfStr?.takeRetainedValue() as String? else {
            return false
        }
        return bundleIDs.contains(bid)
    }
}

func findOutputDevice(named targetName: String) -> AudioDeviceID? {
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDevices,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size) == noErr,
          size > 0 else {
        return nil
    }
    let count = Int(size) / MemoryLayout<AudioDeviceID>.size
    var devices = [AudioDeviceID](repeating: 0, count: count)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &devices) == noErr else {
        return nil
    }
    for dev in devices {
        var nameAddr = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyDeviceNameCFString,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var cfName: Unmanaged<CFString>?
        var nSize = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        guard AudioObjectGetPropertyData(dev, &nameAddr, 0, nil, &nSize, &cfName) == noErr,
              let name = cfName?.takeRetainedValue() as String?,
              name.localizedCaseInsensitiveContains(targetName) else {
            continue
        }
        var streamAddr = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyStreamConfiguration,
            mScope: kAudioDevicePropertyScopeOutput,
            mElement: kAudioObjectPropertyElementMain
        )
        var sSize: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(dev, &streamAddr, 0, nil, &sSize) == noErr, sSize > 0 else {
            continue
        }
        let raw = UnsafeMutableRawPointer.allocate(byteCount: Int(sSize), alignment: MemoryLayout<AudioBufferList>.alignment)
        defer { raw.deallocate() }
        let abl = raw.assumingMemoryBound(to: AudioBufferList.self)
        if AudioObjectGetPropertyData(dev, &streamAddr, 0, nil, &sSize, abl) == noErr {
            let list = UnsafeMutableAudioBufferListPointer(abl)
            let outChannels = list.reduce(0) { $0 + Int($1.mNumberChannels) }
            if outChannels > 0 { return dev }
        }
    }
    return nil
}

func makeOpusFormat() -> AVAudioFormat {
    var asbd = AudioStreamBasicDescription(
        mSampleRate: sampleRate,
        mFormatID: kAudioFormatOpus,
        mFormatFlags: 0,
        mBytesPerPacket: 0,
        mFramesPerPacket: UInt32(frameSamples),
        mBytesPerFrame: 0,
        mChannelsPerFrame: 1,
        mBitsPerChannel: 0,
        mReserved: 0
    )
    return AVAudioFormat(streamDescription: &asbd)!
}

func writeStdoutFrame(_ data: Data) {
    var lenBE = UInt32(data.count).bigEndian
    let header = Data(bytes: &lenBE, count: 4)
    FileHandle.standardOutput.write(header)
    FileHandle.standardOutput.write(data)
}

final class AudioBridge {
    private var tapID: AudioObjectID = kAudioObjectUnknown
    private var aggregateDeviceID: AudioDeviceID = kAudioObjectUnknown
    private var tapIOProcID: AudioDeviceIOProcID?
    private var outDeviceID: AudioDeviceID = kAudioObjectUnknown
    private var outIOProcID: AudioDeviceIOProcID?

    private let downlinkRing = FloatRingBuffer()
    private let uplinkRing = FloatRingBuffer()
    private var isMuted = false
    private let muteLock = NSLock()
    private var running = true

    private let pcmFormat = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: 1)!
    private let opusFormat = makeOpusFormat()
    private lazy var encoder = AVAudioConverter(from: pcmFormat, to: opusFormat)
    private lazy var decoder = AVAudioConverter(from: opusFormat, to: pcmFormat)

    func start() {
        setupUplinkBlackHole()
        setupDownlinkTapWithRetry()
        startDownlinkEncodeLoop()
        readStdinLoop()
    }

    func stop() {
        running = false
        if let proc = tapIOProcID, aggregateDeviceID != kAudioObjectUnknown {
            AudioDeviceStop(aggregateDeviceID, proc)
            AudioDeviceDestroyIOProcID(aggregateDeviceID, proc)
        }
        if aggregateDeviceID != kAudioObjectUnknown {
            AudioHardwareDestroyAggregateDevice(aggregateDeviceID)
        }
        if tapID != kAudioObjectUnknown {
            AudioHardwareDestroyProcessTap(tapID)
        }
        if let proc = outIOProcID, outDeviceID != kAudioObjectUnknown {
            AudioDeviceStop(outDeviceID, proc)
            AudioDeviceDestroyIOProcID(outDeviceID, proc)
        }
    }

    private func setupDownlinkTapWithRetry() {
        DispatchQueue.global(qos: .userInteractive).async { [weak self] in
            guard let self = self else { return }
            while self.running && self.tapID == kAudioObjectUnknown {
                let procIDs = getProcessObjectIDs(matching: targetBundleIDs)
                if !procIDs.isEmpty, self.createProcessTap(processObjectIDs: procIDs) {
                    return
                }
                Thread.sleep(forTimeInterval: 0.5)
            }
        }
    }

    private func createProcessTap(processObjectIDs: [AudioObjectID]) -> Bool {
        let tapDesc = CATapDescription(stereoMixdownOfProcesses: processObjectIDs)
        tapDesc.name = "BlueBubblesFaceTimeTap"
        tapDesc.muteBehavior = .unmuted

        var newTapID: AudioObjectID = kAudioObjectUnknown
        let status = AudioHardwareCreateProcessTap(tapDesc, &newTapID)
        guard status == noErr, newTapID != kAudioObjectUnknown else {
            fputs("[BlueBubblesAudioBridge] AudioHardwareCreateProcessTap failed: \(status)\n", stderr)
            return false
        }
        self.tapID = newTapID

        let aggUID = "com.bluebubbles.audiobridge.tap.\(UUID().uuidString)"
        let aggDesc: [String: Any] = [
            kAudioAggregateDeviceNameKey: "BlueBubblesFaceTimeTapDevice",
            kAudioAggregateDeviceUIDKey: aggUID,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceTapListKey: [
                [
                    kAudioSubTapUIDKey: tapDesc.uuid.uuidString,
                    kAudioSubTapDriftCompensationKey: true,
                ]
            ],
        ]

        var newAggID: AudioDeviceID = kAudioObjectUnknown
        let aggStatus = AudioHardwareCreateAggregateDevice(aggDesc as CFDictionary, &newAggID)
        guard aggStatus == noErr, newAggID != kAudioObjectUnknown else {
            fputs("[BlueBubblesAudioBridge] AudioHardwareCreateAggregateDevice failed: \(aggStatus)\n", stderr)
            AudioHardwareDestroyProcessTap(newTapID)
            self.tapID = kAudioObjectUnknown
            return false
        }
        self.aggregateDeviceID = newAggID

        var procID: AudioDeviceIOProcID?
        let ioStatus = AudioDeviceCreateIOProcIDWithBlock(&procID, newAggID, nil) { [weak self] _, inInputData, _, _, _ in
            guard let self = self else { return }
            let abl = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: inInputData))
            guard let first = abl.first, let mData = first.mData else { return }
            let ch = max(1, Int(first.mNumberChannels))
            let totalFloats = Int(first.mDataByteSize) / MemoryLayout<Float>.size
            let frames = totalFloats / ch
            let ptr = mData.assumingMemoryBound(to: Float.self)
            if ch == 1 {
                self.downlinkRing.push(ptr, length: frames)
            } else {
                var mono = [Float](repeating: 0, count: frames)
                for i in 0..<frames {
                    var sum: Float = 0
                    for c in 0..<ch { sum += ptr[i * ch + c] }
                    mono[i] = sum / Float(ch)
                }
                mono.withUnsafeBufferPointer { bp in
                    if let base = bp.baseAddress { self.downlinkRing.push(base, length: frames) }
                }
            }
        }
        guard ioStatus == noErr, let validProc = procID else {
            fputs("[BlueBubblesAudioBridge] Tap IOProc failed: \(ioStatus)\n", stderr)
            return false
        }
        self.tapIOProcID = validProc
        AudioDeviceStart(newAggID, validProc)
        fputs("[BlueBubblesAudioBridge] CoreAudio Process Tap started for \(processObjectIDs.count) process(es)\n", stderr)
        return true
    }

    private func setupUplinkBlackHole() {
        guard let devID = findOutputDevice(named: "BlackHole 2ch") else {
            fputs("[BlueBubblesAudioBridge] Warning: BlackHole 2ch output device not found; uplink audio disabled\n", stderr)
            return
        }
        self.outDeviceID = devID
        var procID: AudioDeviceIOProcID?
        let status = AudioDeviceCreateIOProcIDWithBlock(&procID, devID, nil) { [weak self] _, _, _, outOutputData, _ in
            guard let self = self else { return }
            let abl = UnsafeMutableAudioBufferListPointer(outOutputData)
            guard let first = abl.first, let mData = first.mData else { return }
            let ch = max(1, Int(first.mNumberChannels))
            let totalFloats = Int(first.mDataByteSize) / MemoryLayout<Float>.size
            let frames = totalFloats / ch
            let dst = mData.assumingMemoryBound(to: Float.self)

            self.muteLock.lock()
            let muted = self.isMuted
            self.muteLock.unlock()

            if muted {
                memset(dst, 0, Int(first.mDataByteSize))
                return
            }

            var mono = [Float](repeating: 0, count: frames)
            let popped = mono.withUnsafeMutableBufferPointer { bp -> Int in
                guard let base = bp.baseAddress else { return 0 }
                return self.uplinkRing.pop(into: base, length: frames)
            }
            if popped < frames {
                for i in popped..<frames { mono[i] = 0 }
            }
            if ch == 1 {
                memcpy(dst, mono, frames * MemoryLayout<Float>.size)
            } else {
                for i in 0..<frames {
                    let s = mono[i]
                    for c in 0..<ch { dst[i * ch + c] = s }
                }
            }
        }
        if status == noErr, let validProc = procID {
            self.outIOProcID = validProc
            AudioDeviceStart(devID, validProc)
            fputs("[BlueBubblesAudioBridge] BlackHole 2ch uplink output started\n", stderr)
        }
    }

    private func startDownlinkEncodeLoop() {
        DispatchQueue.global(qos: .userInteractive).async { [weak self] in
            guard let self = self, let encoder = self.encoder else { return }
            let pcmBuf = AVAudioPCMBuffer(pcmFormat: self.pcmFormat, frameCapacity: AVAudioFrameCount(frameSamples))!
            pcmBuf.frameLength = AVAudioFrameCount(frameSamples)
            let compBuf = AVAudioCompressedBuffer(format: self.opusFormat, packetCapacity: 1, maximumPacketSize: 1500)

            while self.running {
                if self.downlinkRing.available >= frameSamples {
                    if let chData = pcmBuf.floatChannelData?[0] {
                        _ = self.downlinkRing.pop(into: chData, length: frameSamples)
                    }
                    var fed = false
                    var err: NSError?
                    let status = encoder.convert(to: compBuf, error: &err) { _, outStatus in
                        if fed {
                            outStatus.pointee = .noDataNow
                            return nil
                        }
                        fed = true
                        outStatus.pointee = .haveData
                        return pcmBuf
                    }
                    if status != .error && compBuf.byteLength > 0 {
                        let data = Data(bytes: compBuf.data, count: Int(compBuf.byteLength))
                        writeStdoutFrame(data)
                    }
                } else {
                    Thread.sleep(forTimeInterval: 0.005)
                }
            }
        }
    }

    private func readStdinLoop() {
        let stdin = FileHandle.standardInput
        while running {
            let header = stdin.readData(ofLength: 5)
            if header.count < 5 {
                stop()
                break
            }
            let frameType = header[0]
            let length = header.subdata(in: 1..<5).withUnsafeBytes { $0.load(as: UInt32.self).bigEndian }
            if length == 0 || length > 65_536 { continue }
            let payload = stdin.readData(ofLength: Int(length))
            if payload.count < Int(length) {
                stop()
                break
            }
            if frameType == 0x02 {
                muteLock.lock()
                isMuted = payload[0] != 0
                muteLock.unlock()
            } else if frameType == 0x01, let decoder = self.decoder {
                let compBuf = AVAudioCompressedBuffer(format: opusFormat, packetCapacity: 1, maximumPacketSize: Int(length))
                compBuf.byteLength = UInt32(length)
                compBuf.packetCount = 1
                compBuf.packetDescriptions?[0] = AudioStreamPacketDescription(
                    mStartOffset: 0,
                    mVariableFramesInPacket: UInt32(frameSamples),
                    mDataByteSize: UInt32(length)
                )
                payload.copyBytes(to: compBuf.data.assumingMemoryBound(to: UInt8.self), count: Int(length))

                let outBuf = AVAudioPCMBuffer(pcmFormat: pcmFormat, frameCapacity: AVAudioFrameCount(frameSamples * 2))!
                var fed = false
                var err: NSError?
                let st = decoder.convert(to: outBuf, error: &err) { _, outStatus in
                    if fed {
                        outStatus.pointee = .noDataNow
                        return nil
                    }
                    fed = true
                    outStatus.pointee = .haveData
                    return compBuf
                }
                if st != .error, outBuf.frameLength > 0, let ch = outBuf.floatChannelData?[0] {
                    uplinkRing.push(ch, length: Int(outBuf.frameLength))
                }
            }
        }
    }
}

if CommandLine.arguments.contains("--check") {
    let pids = getProcessObjectIDs(matching: targetBundleIDs)
    let blackHole = findOutputDevice(named: "BlackHole 2ch") != nil
    let out = "{\"ok\":true,\"processTapSupported\":true,\"blackHoleFound\":\(blackHole),\"targetProcessCount\":\(pids.count)}\n"
    FileHandle.standardOutput.write(Data(out.utf8))
    exit(0)
}

let bridge = AudioBridge()
signal(SIGTERM) { _ in exit(0) }
signal(SIGINT) { _ in exit(0) }
bridge.start()
