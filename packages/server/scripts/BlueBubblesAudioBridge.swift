import Accelerate
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
    private var stopped = false
    private let signalThreshold: Int
    private let lock = NSCondition()

    init(capacity: Int = 48_000 * 2, signalThreshold: Int = 0) {
        self.buf = [Float](repeating: 0, count: capacity)
        self.signalThreshold = signalThreshold
    }

    func push(_ samples: UnsafePointer<Float>, length: Int) {
        lock.lock()
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
        if signalThreshold > 0 && count >= signalThreshold {
            lock.signal()
        }
        lock.unlock()
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

    func popOrWait(into dst: UnsafeMutablePointer<Float>, length: Int, timeout: TimeInterval = 0.5) -> Int {
        lock.lock()
        defer { lock.unlock() }
        let deadline = Date(timeIntervalSinceNow: timeout)
        while count < length && !stopped {
            if !lock.wait(until: deadline) {
                return 0
            }
        }
        guard !stopped, count >= length else {
            return 0
        }
        let cap = buf.count
        for i in 0..<length {
            dst[i] = buf[readIdx]
            readIdx = (readIdx + 1) % cap
        }
        count -= length
        return length
    }

    func stop() {
        lock.lock()
        stopped = true
        lock.broadcast()
        lock.unlock()
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

func findDevice(named targetName: String, scope: AudioObjectPropertyScope) -> AudioDeviceID? {
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
            mScope: scope,
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
            let channels = list.reduce(0) { $0 + Int($1.mNumberChannels) }
            if channels > 0 { return dev }
        }
    }
    return nil
}

func getDefaultInputDevice() -> AudioDeviceID? {
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDefaultInputDevice,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var devID: AudioDeviceID = kAudioObjectUnknown
    var size = UInt32(MemoryLayout<AudioDeviceID>.size)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &devID) == noErr,
          devID != kAudioObjectUnknown else {
        return nil
    }
    return devID
}

@discardableResult
func setDefaultInputDevice(_ deviceID: AudioDeviceID) -> Bool {
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDefaultInputDevice,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var devID = deviceID
    let size = UInt32(MemoryLayout<AudioDeviceID>.size)
    return AudioObjectSetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, size, &devID) == noErr
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

final class AudioBridge {
    private let tapLifecycleLock = NSLock()
    private let tapQueue = DispatchQueue(label: "com.bluebubbles.audiobridge.tap")
    private var tapID: AudioObjectID = kAudioObjectUnknown
    private var aggregateDeviceID: AudioDeviceID = kAudioObjectUnknown
    private var tapIOProcID: AudioDeviceIOProcID?
    private var tappedProcessObjectIDs: [AudioObjectID] = []
    private var tapRetryInFlight = false
    private var processListListenerBlock: AudioObjectPropertyListenerBlock?
    private var outDeviceID: AudioDeviceID = kAudioObjectUnknown
    private var outIOProcID: AudioDeviceIOProcID?
    private var savedDefaultInputDeviceID: AudioDeviceID = kAudioObjectUnknown
    private let inputRestoreLock = NSLock()

    private let downlinkRing = FloatRingBuffer(signalThreshold: frameSamples)
    private let uplinkRing = FloatRingBuffer()
    private var isMuted = false
    private let muteLock = NSLock()
    private var voiceIsolationEnabled = true
    private var running = true
    private var tapMonoScratch = [Float](repeating: 0, count: 4096)
    private var uplinkMonoScratch = [Float](repeating: 0, count: 4096)

    private let statsLock = NSLock()
    private var statsTimer: DispatchSourceTimer?
    private var downlinkIoFrames = 0
    private var downlinkSumSquares: Double = 0
    private var downlinkEncodedFrames = 0
    private var downlinkEncodeErrors = 0
    private var uplinkStdinFrames = 0
    private var uplinkDecodedFrames = 0
    private var uplinkDecodeErrors = 0
    private var uplinkIoFrames = 0
    private var uplinkSumSquares: Double = 0
    private var lastDecodeErrorLogTime: CFAbsoluteTime = 0
    private var suppressedDecodeErrors = 0

    // 80 Hz 2nd-order Butterworth high-pass biquad @ 48 kHz + soft peak limiter for uplink
    private let hpfSetup: vDSP_biquad_Setup? = {
        let w0 = 2.0 * Double.pi * 80.0 / sampleRate
        let cosw0 = cos(w0)
        let sinw0 = sin(w0)
        let alpha = sinw0 / (2.0 * (1.0 / sqrt(2.0)))
        let a0 = 1.0 + alpha
        let coeffs: [Double] = [
            ((1.0 + cosw0) / 2.0) / a0,
            -(1.0 + cosw0) / a0,
            ((1.0 + cosw0) / 2.0) / a0,
            (-2.0 * cosw0) / a0,
            (1.0 - alpha) / a0,
        ]
        return vDSP_biquad_CreateSetup(coeffs, 1)
    }()
    private var hpfDelay = [Float](repeating: 0, count: 4)
    private var hpfScratch = [Float](repeating: 0, count: frameSamples * 2)

    private let pcmFormat = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: 1)!
    private let opusFormat = makeOpusFormat()
    private lazy var encoder = AVAudioConverter(from: pcmFormat, to: opusFormat)
    private lazy var decoder = AVAudioConverter(from: opusFormat, to: pcmFormat)

    func start() {
        setupUplinkBlackHole()
        startProcessObjectListMonitor()
        setupDownlinkTapWithRetry()
        startStatsTimer()
        startDownlinkEncodeLoop()
        readStdinLoop()
    }

    func stop() {
        statsLock.lock()
        statsTimer?.cancel()
        statsTimer = nil
        statsLock.unlock()

        tapLifecycleLock.lock()
        running = false
        if let block = processListListenerBlock {
            var addr = AudioObjectPropertyAddress(
                mSelector: kAudioHardwarePropertyProcessObjectList,
                mScope: kAudioObjectPropertyScopeGlobal,
                mElement: kAudioObjectPropertyElementMain
            )
            AudioObjectRemovePropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &addr, tapQueue, block)
            processListListenerBlock = nil
        }
        downlinkRing.stop()
        restoreDefaultInputDevice()
        destroyDownlinkTapLocked()
        if let proc = outIOProcID, outDeviceID != kAudioObjectUnknown {
            AudioDeviceStop(outDeviceID, proc)
            AudioDeviceDestroyIOProcID(outDeviceID, proc)
        }
        outIOProcID = nil
        outDeviceID = kAudioObjectUnknown
        tapLifecycleLock.unlock()
    }

    private func destroyDownlinkTapLocked() {
        if let proc = tapIOProcID, aggregateDeviceID != kAudioObjectUnknown {
            AudioDeviceStop(aggregateDeviceID, proc)
            AudioDeviceDestroyIOProcID(aggregateDeviceID, proc)
        }
        tapIOProcID = nil
        if aggregateDeviceID != kAudioObjectUnknown {
            AudioHardwareDestroyAggregateDevice(aggregateDeviceID)
            aggregateDeviceID = kAudioObjectUnknown
        }
        if tapID != kAudioObjectUnknown {
            AudioHardwareDestroyProcessTap(tapID)
            tapID = kAudioObjectUnknown
        }
        tappedProcessObjectIDs = []
    }

    private func startProcessObjectListMonitor() {
        tapLifecycleLock.lock()
        defer { tapLifecycleLock.unlock() }
        guard processListListenerBlock == nil else { return }
        var addr = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyProcessObjectList,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        let block: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
            guard let self = self, self.running else { return }
            self.recreateDownlinkTap(reason: "processObjectListChanged", force: false)
        }
        let status = AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &addr, tapQueue, block)
        if status == noErr {
            processListListenerBlock = block
        } else {
            fputs("[BlueBubblesAudioBridge] Warning: failed to observe process object list (\(status))\n", stderr)
        }
    }

    private func recreateDownlinkTap(reason: String, force: Bool) {
        let procIDs = getProcessObjectIDs(matching: targetBundleIDs).sorted()
        guard !procIDs.isEmpty else {
            fputs("[BlueBubblesAudioBridge] No target process objects found during re-tap (\(reason))\n", stderr)
            return
        }
        tapLifecycleLock.lock()
        guard running else {
            tapLifecycleLock.unlock()
            return
        }
        if !force && tapID != kAudioObjectUnknown && procIDs == tappedProcessObjectIDs {
            tapLifecycleLock.unlock()
            return
        }
        if tapID != kAudioObjectUnknown {
            fputs("[BlueBubblesAudioBridge] Recreating CoreAudio Process Tap (\(reason)) for \(procIDs.count) process(es): \(procIDs)\n", stderr)
            destroyDownlinkTapLocked()
        }
        let ok = createProcessTapLocked(processObjectIDs: procIDs)
        tapLifecycleLock.unlock()
        if !ok {
            setupDownlinkTapWithRetry()
        }
    }

    private func restoreDefaultInputDevice() {
        inputRestoreLock.lock()
        let saved = savedDefaultInputDeviceID
        savedDefaultInputDeviceID = kAudioObjectUnknown
        inputRestoreLock.unlock()
        if saved != kAudioObjectUnknown {
            setDefaultInputDevice(saved)
            fputs("[BlueBubblesAudioBridge] Restored default input device (\(saved))\n", stderr)
        }
    }

    private func setupDownlinkTapWithRetry() {
        tapLifecycleLock.lock()
        if tapRetryInFlight || !running {
            tapLifecycleLock.unlock()
            return
        }
        tapRetryInFlight = true
        tapLifecycleLock.unlock()

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self = self else { return }
            defer {
                self.tapLifecycleLock.lock()
                self.tapRetryInFlight = false
                self.tapLifecycleLock.unlock()
            }
            var delay: TimeInterval = 0.5
            var elapsed: TimeInterval = 0
            var loggedSlowWait = false
            while self.running {
                self.tapLifecycleLock.lock()
                let hasTap = self.tapID != kAudioObjectUnknown
                self.tapLifecycleLock.unlock()
                if hasTap { return }

                let procIDs = getProcessObjectIDs(matching: targetBundleIDs).sorted()
                if !procIDs.isEmpty {
                    self.tapLifecycleLock.lock()
                    let created = self.running && self.tapID == kAudioObjectUnknown ? self.createProcessTapLocked(processObjectIDs: procIDs) : true
                    self.tapLifecycleLock.unlock()
                    if created { return }
                }
                if !loggedSlowWait && elapsed >= 60.0 {
                    loggedSlowWait = true
                    fputs("[BlueBubblesAudioBridge] Still waiting for FaceTime audio process tap after 60s; continuing retry every 5s\n", stderr)
                }
                Thread.sleep(forTimeInterval: delay)
                elapsed += delay
                delay = min(5.0, delay * 2.0)
            }
        }
    }

    private func createProcessTapLocked(processObjectIDs: [AudioObjectID]) -> Bool {
        guard running else { return false }

        let tapDesc = CATapDescription(stereoMixdownOfProcesses: processObjectIDs)
        tapDesc.name = "BlueBubblesFaceTimeTap"
        tapDesc.muteBehavior = .mutedWhenTapped

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
            guard !abl.isEmpty else { return }

            if abl.count == 1 {
                guard let first = abl.first, let mData = first.mData, first.mDataByteSize > 0 else { return }
                let ch = max(1, Int(first.mNumberChannels))
                let frames = (Int(first.mDataByteSize) / MemoryLayout<Float>.size) / ch
                guard frames > 0 else { return }
                let ptr = mData.assumingMemoryBound(to: Float.self)
                if ch == 1 {
                    self.downlinkRing.push(ptr, length: frames)
                    self.recordDownlinkIo(ptr, frames: frames)
                } else {
                    if self.tapMonoScratch.count < frames {
                        self.tapMonoScratch = [Float](repeating: 0, count: frames)
                    }
                    let invCh = 1.0 / Float(ch)
                    for i in 0..<frames {
                        var sum: Float = 0
                        for c in 0..<ch { sum += ptr[i * ch + c] }
                        self.tapMonoScratch[i] = sum * invCh
                    }
                    self.tapMonoScratch.withUnsafeBufferPointer { bp in
                        if let base = bp.baseAddress {
                            self.downlinkRing.push(base, length: frames)
                            self.recordDownlinkIo(base, frames: frames)
                        }
                    }
                }
            } else {
                var frames = Int.max
                var totalChannels = 0
                for buf in abl {
                    guard buf.mData != nil, buf.mDataByteSize > 0 else { continue }
                    let bCh = max(1, Int(buf.mNumberChannels))
                    let bFrames = (Int(buf.mDataByteSize) / MemoryLayout<Float>.size) / bCh
                    if bFrames > 0 {
                        frames = min(frames, bFrames)
                        totalChannels += bCh
                    }
                }
                guard totalChannels > 0, frames > 0, frames < Int.max else { return }
                if self.tapMonoScratch.count < frames {
                    self.tapMonoScratch = [Float](repeating: 0, count: frames)
                }
                for i in 0..<frames { self.tapMonoScratch[i] = 0 }
                for buf in abl {
                    guard let mData = buf.mData, buf.mDataByteSize > 0 else { continue }
                    let bCh = max(1, Int(buf.mNumberChannels))
                    let bFrames = (Int(buf.mDataByteSize) / MemoryLayout<Float>.size) / bCh
                    guard bFrames >= frames else { continue }
                    let ptr = mData.assumingMemoryBound(to: Float.self)
                    if bCh == 1 {
                        for i in 0..<frames { self.tapMonoScratch[i] += ptr[i] }
                    } else {
                        for i in 0..<frames {
                            for c in 0..<bCh { self.tapMonoScratch[i] += ptr[i * bCh + c] }
                        }
                    }
                }
                let invCh = 1.0 / Float(totalChannels)
                for i in 0..<frames { self.tapMonoScratch[i] *= invCh }
                self.tapMonoScratch.withUnsafeBufferPointer { bp in
                    if let base = bp.baseAddress {
                        self.downlinkRing.push(base, length: frames)
                        self.recordDownlinkIo(base, frames: frames)
                    }
                }
            }
        }
        guard ioStatus == noErr, let validProc = procID else {
            fputs("[BlueBubblesAudioBridge] Tap IOProc failed: \(ioStatus)\n", stderr)
            AudioHardwareDestroyAggregateDevice(newAggID)
            AudioHardwareDestroyProcessTap(newTapID)
            self.aggregateDeviceID = kAudioObjectUnknown
            self.tapID = kAudioObjectUnknown
            self.tapIOProcID = nil
            return false
        }
        self.tapIOProcID = validProc
        self.tappedProcessObjectIDs = processObjectIDs.sorted()
        AudioDeviceStart(newAggID, validProc)
        fputs("[BlueBubblesAudioBridge] CoreAudio Process Tap started for \(processObjectIDs.count) process(es): \(self.tappedProcessObjectIDs)\n", stderr)
        return true
    }

    private func setupUplinkBlackHole() {
        guard let devID = findDevice(named: "BlackHole 2ch", scope: kAudioDevicePropertyScopeOutput) else {
            fputs("[BlueBubblesAudioBridge] Warning: BlackHole 2ch output device not found; uplink audio disabled\n", stderr)
            return
        }
        if let inDevID = findDevice(named: "BlackHole 2ch", scope: kAudioDevicePropertyScopeInput),
           let currentInput = getDefaultInputDevice(),
           currentInput != inDevID {
            inputRestoreLock.lock()
            savedDefaultInputDeviceID = currentInput
            inputRestoreLock.unlock()
            if setDefaultInputDevice(inDevID) {
                fputs("[BlueBubblesAudioBridge] Switched default input device to BlackHole 2ch (\(inDevID)), saved \(currentInput)\n", stderr)
            } else {
                inputRestoreLock.lock()
                savedDefaultInputDeviceID = kAudioObjectUnknown
                inputRestoreLock.unlock()
            }
        }
        self.outDeviceID = devID
        var procID: AudioDeviceIOProcID?
        let status = AudioDeviceCreateIOProcIDWithBlock(&procID, devID, nil) { [weak self] _, _, _, outOutputData, _ in
            guard let self = self else { return }
            let abl = UnsafeMutableAudioBufferListPointer(outOutputData)
            guard let first = abl.first, first.mData != nil, first.mDataByteSize > 0 else { return }
            let firstCh = max(1, Int(first.mNumberChannels))
            let frames = (Int(first.mDataByteSize) / MemoryLayout<Float>.size) / firstCh
            guard frames > 0 else { return }

            self.muteLock.lock()
            let muted = self.isMuted
            self.muteLock.unlock()

            if muted {
                for buf in abl {
                    if let mData = buf.mData, buf.mDataByteSize > 0 {
                        memset(mData, 0, Int(buf.mDataByteSize))
                    }
                }
                return
            }

            if self.uplinkMonoScratch.count < frames {
                self.uplinkMonoScratch = [Float](repeating: 0, count: frames)
            }
            let popped = self.uplinkMonoScratch.withUnsafeMutableBufferPointer { bp -> Int in
                guard let base = bp.baseAddress else { return 0 }
                return self.uplinkRing.pop(into: base, length: frames)
            }
            if popped < frames {
                for i in popped..<frames { self.uplinkMonoScratch[i] = 0 }
            }
            self.recordUplinkIo(frames: frames)

            for buf in abl {
                guard let mData = buf.mData, buf.mDataByteSize > 0 else { continue }
                let bCh = max(1, Int(buf.mNumberChannels))
                let bFrames = min(frames, (Int(buf.mDataByteSize) / MemoryLayout<Float>.size) / bCh)
                guard bFrames > 0 else { continue }
                let dst = mData.assumingMemoryBound(to: Float.self)
                if bCh == 1 {
                    self.uplinkMonoScratch.withUnsafeBufferPointer { bp in
                        if let base = bp.baseAddress {
                            memcpy(dst, base, bFrames * MemoryLayout<Float>.size)
                        }
                    }
                } else {
                    for i in 0..<bFrames {
                        let s = self.uplinkMonoScratch[i]
                        for c in 0..<bCh { dst[i * bCh + c] = s }
                    }
                }
            }
        }
        if status == noErr, let validProc = procID {
            self.outIOProcID = validProc
            AudioDeviceStart(devID, validProc)
            fputs("[BlueBubblesAudioBridge] BlackHole 2ch uplink output started\n", stderr)
        }
    }

    private func writeAllStdout(_ buffer: UnsafeRawPointer, count: Int) -> Bool {
        var offset = 0
        while offset < count {
            let written = Darwin.write(STDOUT_FILENO, buffer.advanced(by: offset), count - offset)
            if written > 0 {
                offset += written
            } else if written == 0 {
                return false
            } else {
                if errno == EINTR { continue }
                return false
            }
        }
        return true
    }

    private func writeStdoutFrame(_ data: Data) {
        var lenBE = UInt32(data.count).bigEndian
        let headerOK = withUnsafeBytes(of: &lenBE) { bp -> Bool in
            guard let base = bp.baseAddress else { return false }
            return writeAllStdout(base, count: 4)
        }
        if !headerOK {
            stop()
            exit(0)
        }
        if !data.isEmpty {
            let bodyOK = data.withUnsafeBytes { bp -> Bool in
                guard let base = bp.baseAddress else { return false }
                return writeAllStdout(base, count: data.count)
            }
            if !bodyOK {
                stop()
                exit(0)
            }
        }
    }

    private func recordDownlinkIo(_ ptr: UnsafePointer<Float>, frames: Int) {
        var sumSq: Float = 0
        vDSP_svesq(ptr, 1, &sumSq, vDSP_Length(frames))
        statsLock.lock()
        downlinkIoFrames += frames
        downlinkSumSquares += Double(sumSq)
        statsLock.unlock()
    }

    private func recordUplinkIo(frames: Int) {
        statsLock.lock()
        uplinkIoFrames += frames
        statsLock.unlock()
    }

    private func startStatsTimer() {
        let timer = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "com.bluebubbles.audiobridge.stats"))
        timer.schedule(deadline: .now() + 5.0, repeating: 5.0)
        timer.setEventHandler { [weak self] in
            guard let self = self, self.running else { return }
            self.statsLock.lock()
            let dlIo = self.downlinkIoFrames
            let dlSumSq = self.downlinkSumSquares
            let dlEnc = self.downlinkEncodedFrames
            let dlErr = self.downlinkEncodeErrors
            let ulStdin = self.uplinkStdinFrames
            let ulDec = self.uplinkDecodedFrames
            let ulErr = self.uplinkDecodeErrors
            let ulIo = self.uplinkIoFrames
            let ulSumSq = self.uplinkSumSquares
            self.downlinkIoFrames = 0
            self.downlinkSumSquares = 0
            self.downlinkEncodedFrames = 0
            self.downlinkEncodeErrors = 0
            self.uplinkStdinFrames = 0
            self.uplinkDecodedFrames = 0
            self.uplinkDecodeErrors = 0
            self.uplinkIoFrames = 0
            self.uplinkSumSquares = 0
            self.statsLock.unlock()

            let dlRms = dlIo > 0 ? sqrt(dlSumSq / Double(dlIo)) : 0.0
            let dlDb = dlRms > 1e-9 ? 20.0 * log10(dlRms) : -120.0
            let ulRms = ulDec > 0 ? sqrt(ulSumSq / Double(ulDec)) : 0.0
            let ulDb = ulRms > 1e-9 ? 20.0 * log10(ulRms) : -120.0
            fputs(
                "[BlueBubblesAudioBridge] Stats (5s): downlink(ioFrames=\(dlIo), encFrames=\(dlEnc), encErr=\(dlErr), rms=\(String(format: "%.6f", dlRms)), dBFS=\(String(format: "%.1f", dlDb))) uplink(stdinFrames=\(ulStdin), decFrames=\(ulDec), decErr=\(ulErr), ioFrames=\(ulIo), rms=\(String(format: "%.6f", ulRms)), dBFS=\(String(format: "%.1f", ulDb)))\n",
                stderr
            )
        }
        statsLock.lock()
        statsTimer = timer
        statsLock.unlock()
        timer.resume()
    }

    private func startDownlinkEncodeLoop() {
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self = self, let encoder = self.encoder else { return }
            encoder.bitRate = 48_000
            let pcmBuf = AVAudioPCMBuffer(pcmFormat: self.pcmFormat, frameCapacity: AVAudioFrameCount(frameSamples))!
            pcmBuf.frameLength = AVAudioFrameCount(frameSamples)
            let compBuf = AVAudioCompressedBuffer(format: self.opusFormat, packetCapacity: 1, maximumPacketSize: 1500)

            while self.running {
                guard let chData = pcmBuf.floatChannelData?[0] else { break }
                let popped = self.downlinkRing.popOrWait(into: chData, length: frameSamples, timeout: 0.5)
                guard popped == frameSamples, self.running else { continue }
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
                    self.statsLock.lock()
                    self.downlinkEncodedFrames += 1
                    self.statsLock.unlock()
                    let data = Data(bytes: compBuf.data, count: Int(compBuf.byteLength))
                    self.writeStdoutFrame(data)
                } else {
                    self.statsLock.lock()
                    self.downlinkEncodeErrors += 1
                    self.statsLock.unlock()
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
            } else if frameType == 0x04 {
                voiceIsolationEnabled = payload[0] != 0
                fputs("[BlueBubblesAudioBridge] Uplink vDSP HPF/limiter \(voiceIsolationEnabled ? "enabled" : "disabled")\n", stderr)
            } else if frameType == 0x05 {
                fputs("[BlueBubblesAudioBridge] Received answered command; recreating process tap\n", stderr)
                tapQueue.async { [weak self] in
                    self?.recreateDownlinkTap(reason: "answered", force: true)
                }
            } else if frameType == 0x03, let ch = Character(UnicodeScalar(payload[0])).uppercased().first {
                pushDtmfTone(digit: ch)
            } else if frameType == 0x01, let decoder = self.decoder {
                statsLock.lock()
                uplinkStdinFrames += 1
                statsLock.unlock()
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
                    let count = Int(outBuf.frameLength)
                    let pcmPtr: UnsafePointer<Float>
                    if voiceIsolationEnabled, let setup = hpfSetup {
                        if hpfScratch.count < count {
                            hpfScratch = [Float](repeating: 0, count: count)
                        }
                        vDSP_biquad(setup, &hpfDelay, ch, 1, &hpfScratch, 1, vDSP_Length(count))
                        for i in 0..<count {
                            let s = hpfScratch[i]
                            if s > 0.85 {
                                hpfScratch[i] = min(0.99, 0.85 + 0.14 * tanhf((s - 0.85) / 0.14))
                            } else if s < -0.85 {
                                hpfScratch[i] = max(-0.99, -0.85 - 0.14 * tanhf((-s - 0.85) / 0.14))
                            }
                        }
                        hpfScratch.withUnsafeBufferPointer { bp in
                            if let base = bp.baseAddress {
                                uplinkRing.push(base, length: count)
                                var sumSq: Float = 0
                                vDSP_svesq(base, 1, &sumSq, vDSP_Length(count))
                                statsLock.lock()
                                uplinkDecodedFrames += count
                                uplinkSumSquares += Double(sumSq)
                                statsLock.unlock()
                            }
                        }
                    } else {
                        pcmPtr = UnsafePointer(ch)
                        uplinkRing.push(pcmPtr, length: count)
                        var sumSq: Float = 0
                        vDSP_svesq(pcmPtr, 1, &sumSq, vDSP_Length(count))
                        statsLock.lock()
                        uplinkDecodedFrames += count
                        uplinkSumSquares += Double(sumSq)
                        statsLock.unlock()
                    }
                } else {
                    let now = CFAbsoluteTimeGetCurrent()
                    var shouldLog = false
                    var suppressed = 0
                    statsLock.lock()
                    uplinkDecodeErrors += 1
                    if now - lastDecodeErrorLogTime >= 5.0 {
                        lastDecodeErrorLogTime = now
                        suppressed = suppressedDecodeErrors
                        suppressedDecodeErrors = 0
                        shouldLog = true
                    } else {
                        suppressedDecodeErrors += 1
                    }
                    statsLock.unlock()
                    if shouldLog {
                        fputs("[BlueBubblesAudioBridge] Warning: Opus decode failed (status=\(st.rawValue), frames=\(outBuf.frameLength), inBytes=\(length), err=\(err?.localizedDescription ?? "none"), suppressed=\(suppressed))\n", stderr)
                    }
                }
            }
        }
    }

    private func pushDtmfTone(digit: Character) {
        let freqs: [Character: (Double, Double)] = [
            "1": (697, 1209), "2": (697, 1336), "3": (697, 1477), "A": (697, 1633),
            "4": (770, 1209), "5": (770, 1336), "6": (770, 1477), "B": (770, 1633),
            "7": (852, 1209), "8": (852, 1336), "9": (852, 1477), "C": (852, 1633),
            "*": (941, 1209), "0": (941, 1336), "#": (941, 1477), "D": (941, 1633),
        ]
        guard let (fLow, fHigh) = freqs[digit] else { return }
        let totalSamples = Int(0.160 * sampleRate) // 160ms @ 48kHz
        let rampSamples = Int(0.005 * sampleRate)  // 5ms fade-in/out
        var samples = [Float](repeating: 0, count: totalSamples)
        for i in 0..<totalSamples {
            let t = Double(i) / sampleRate
            var env = 1.0
            if i < rampSamples {
                env = Double(i) / Double(rampSamples)
            } else if i >= totalSamples - rampSamples {
                env = Double(totalSamples - 1 - i) / Double(rampSamples)
            }
            samples[i] = Float(0.25 * env * (sin(2.0 * .pi * fLow * t) + sin(2.0 * .pi * fHigh * t)))
        }
        samples.withUnsafeBufferPointer { bp in
            if let base = bp.baseAddress {
                uplinkRing.push(base, length: totalSamples)
            }
        }
    }
}

if CommandLine.arguments.contains("--check") {
    let pids = getProcessObjectIDs(matching: targetBundleIDs)
    let blackHole = findDevice(named: "BlackHole 2ch", scope: kAudioDevicePropertyScopeOutput) != nil
    let out = "{\"ok\":true,\"processTapSupported\":true,\"blackHoleFound\":\(blackHole),\"targetProcessCount\":\(pids.count)}\n"
    FileHandle.standardOutput.write(Data(out.utf8))
    exit(0)
}

let bridge = AudioBridge()
let sigQueue = DispatchQueue(label: "com.bluebubbles.audiobridge.signals")
signal(SIGPIPE, SIG_IGN)
signal(SIGTERM, SIG_IGN)
signal(SIGINT, SIG_IGN)
let termSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: sigQueue)
termSource.setEventHandler {
    bridge.stop()
    exit(0)
}
termSource.resume()
let intSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: sigQueue)
intSource.setEventHandler {
    bridge.stop()
    exit(0)
}
intSource.resume()
bridge.start()
bridge.stop()
