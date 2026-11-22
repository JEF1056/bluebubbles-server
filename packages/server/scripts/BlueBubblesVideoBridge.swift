import CoreGraphics
import CoreMedia
import CoreVideo
import Foundation
import ScreenCaptureKit
import VideoToolbox

// Build: ./scripts/build-video-bridge.sh

private let targetBundleID = "com.apple.FaceTime"
private let maxWidth = 1280
private let maxHeight = 720
private let targetFPS = 30
private let targetBitrate = 1_500_000
private let annexBStartCode: [UInt8] = [0x00, 0x00, 0x00, 0x01]

private func log(_ msg: String) {
    fputs("[BlueBubblesVideoBridge] \(msg)\n", stderr)
}

private let stdoutLock = NSLock()

private func writeStdoutFrame(_ data: Data) {
    var lenBE = UInt32(data.count).bigEndian
    let header = Data(bytes: &lenBE, count: 4)
    stdoutLock.lock()
    do {
        try FileHandle.standardOutput.write(contentsOf: header)
        try FileHandle.standardOutput.write(contentsOf: data)
        stdoutLock.unlock()
    } catch {
        stdoutLock.unlock()
        log("Stdout write failed: \(error.localizedDescription); exiting")
        exit(1)
    }
}

private func evenDimension(_ value: Int, minimum: Int = 2) -> Int {
    let clamped = max(minimum, value)
    return clamped & ~1
}

private func scaledDimensions(for rect: CGRect) -> (width: Int, height: Int) {
    let w = max(1.0, Double(rect.width))
    let h = max(1.0, Double(rect.height))
    let scale = min(1.0, min(Double(maxWidth) / w, Double(maxHeight) / h))
    return (evenDimension(Int(w * scale), minimum: 64), evenDimension(Int(h * scale), minimum: 64))
}

final class H264Encoder {
    private var session: VTCompressionSession?
    private let width: Int
    private let height: Int
    private let onAccessUnit: (Data) -> Void
    private var frameIndex: Int64 = 0

    init?(width: Int, height: Int, onAccessUnit: @escaping (Data) -> Void) {
        self.width = evenDimension(width, minimum: 64)
        self.height = evenDimension(height, minimum: 64)
        self.onAccessUnit = onAccessUnit

        var created: VTCompressionSession?
        let status = VTCompressionSessionCreate(
            allocator: nil,
            width: Int32(self.width),
            height: Int32(self.height),
            codecType: kCMVideoCodecType_H264,
            encoderSpecification: nil,
            imageBufferAttributes: nil,
            compressedDataAllocator: nil,
            outputCallback: h264OutputCallback,
            refcon: Unmanaged.passUnretained(self).toOpaque(),
            compressionSessionOut: &created
        )
        guard status == noErr, let vtSession = created else {
            log("VTCompressionSessionCreate failed: \(status)")
            return nil
        }

        VTSessionSetProperty(vtSession, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
        VTSessionSetProperty(vtSession, key: kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse)
        VTSessionSetProperty(vtSession, key: kVTCompressionPropertyKey_ProfileLevel, value: kVTProfileLevel_H264_Main_AutoLevel)
        VTSessionSetProperty(vtSession, key: kVTCompressionPropertyKey_H264EntropyMode, value: kVTH264EntropyMode_CABAC)
        VTSessionSetProperty(vtSession, key: kVTCompressionPropertyKey_AverageBitRate, value: targetBitrate as CFNumber)
        VTSessionSetProperty(vtSession, key: kVTCompressionPropertyKey_ExpectedFrameRate, value: targetFPS as CFNumber)
        VTSessionSetProperty(vtSession, key: kVTCompressionPropertyKey_MaxKeyFrameInterval, value: (targetFPS * 2) as CFNumber)
        VTSessionSetProperty(vtSession, key: kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration, value: 2.0 as CFNumber)

        let prepStatus = VTCompressionSessionPrepareToEncodeFrames(vtSession)
        if prepStatus != noErr {
            log("VTCompressionSessionPrepareToEncodeFrames warning: \(prepStatus)")
        }
        self.session = vtSession
    }

    deinit {
        invalidate()
    }

    func invalidate() {
        if let vtSession = session {
            VTCompressionSessionCompleteFrames(vtSession, untilPresentationTimeStamp: .invalid)
            VTCompressionSessionInvalidate(vtSession)
            session = nil
        }
    }

    func encode(pixelBuffer: CVPixelBuffer, pts: CMTime, duration: CMTime, forceKeyframe: Bool = false) {
        guard let vtSession = session else { return }
        var props: [CFString: Any]?
        if forceKeyframe {
            props = [kVTEncodeFrameOptionKey_ForceKeyFrame: kCFBooleanTrue!]
        }
        let status = VTCompressionSessionEncodeFrame(
            vtSession,
            imageBuffer: pixelBuffer,
            presentationTimeStamp: pts,
            duration: duration,
            frameProperties: props as CFDictionary?,
            sourceFrameRefcon: nil,
            infoFlagsOut: nil
        )
        if status != noErr {
            log("VTCompressionSessionEncodeFrame failed: \(status)")
        }
        frameIndex += 1
    }

    func flush() {
        guard let vtSession = session else { return }
        VTCompressionSessionCompleteFrames(vtSession, untilPresentationTimeStamp: .invalid)
    }

    fileprivate func handleEncodedSample(_ sampleBuffer: CMSampleBuffer) {
        guard CMSampleBufferDataIsReady(sampleBuffer) else { return }

        let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[CFString: Any]]
        let notSync = attachments?.first?[kCMSampleAttachmentKey_NotSync] as? Bool ?? false
        let isKeyFrame = !notSync

        var accessUnit = Data()

        if isKeyFrame, let formatDesc = CMSampleBufferGetFormatDescription(sampleBuffer) {
            var paramCount = 0
            CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
                formatDesc,
                parameterSetIndex: 0,
                parameterSetPointerOut: nil,
                parameterSetSizeOut: nil,
                parameterSetCountOut: &paramCount,
                nalUnitHeaderLengthOut: nil
            )
            for idx in 0..<paramCount {
                var ptr: UnsafePointer<UInt8>?
                var size = 0
                let psStatus = CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
                    formatDesc,
                    parameterSetIndex: idx,
                    parameterSetPointerOut: &ptr,
                    parameterSetSizeOut: &size,
                    parameterSetCountOut: nil,
                    nalUnitHeaderLengthOut: nil
                )
                if psStatus == noErr, let ptr = ptr, size > 0 {
                    accessUnit.append(contentsOf: annexBStartCode)
                    accessUnit.append(ptr, count: size)
                }
            }
        }

        guard let blockBuffer = CMSampleBufferGetDataBuffer(sampleBuffer) else { return }
        let totalLength = CMBlockBufferGetDataLength(blockBuffer)
        guard totalLength > 0 else { return }

        var dataPtr: UnsafeMutablePointer<Int8>?
        var lengthAtOffset = 0
        let ptrStatus = CMBlockBufferGetDataPointer(
            blockBuffer,
            atOffset: 0,
            lengthAtOffsetOut: &lengthAtOffset,
            totalLengthOut: nil,
            dataPointerOut: &dataPtr
        )

        if ptrStatus == kCMBlockBufferNoErr, lengthAtOffset == totalLength, let rawPtr = dataPtr {
            let bytes = UnsafeRawPointer(rawPtr).assumingMemoryBound(to: UInt8.self)
            appendAVCCNALUs(from: bytes, totalLength: totalLength, into: &accessUnit)
        } else {
            var copy = Data(count: totalLength)
            let copyStatus = copy.withUnsafeMutableBytes { buf -> OSStatus in
                guard let base = buf.baseAddress else { return -1 }
                return CMBlockBufferCopyDataBytes(blockBuffer, atOffset: 0, dataLength: totalLength, destination: base)
            }
            guard copyStatus == kCMBlockBufferNoErr else { return }
            copy.withUnsafeBytes { buf in
                guard let base = buf.bindMemory(to: UInt8.self).baseAddress else { return }
                appendAVCCNALUs(from: base, totalLength: totalLength, into: &accessUnit)
            }
        }

        if !accessUnit.isEmpty {
            onAccessUnit(accessUnit)
        }
    }

    private func appendAVCCNALUs(from bytes: UnsafePointer<UInt8>, totalLength: Int, into accessUnit: inout Data) {
        var offset = 0
        while offset + 4 <= totalLength {
            let naluLen = Int(bytes[offset]) << 24
                | Int(bytes[offset + 1]) << 16
                | Int(bytes[offset + 2]) << 8
                | Int(bytes[offset + 3])
            offset += 4
            guard naluLen > 0, offset + naluLen <= totalLength else { break }
            accessUnit.append(contentsOf: annexBStartCode)
            accessUnit.append(bytes + offset, count: naluLen)
            offset += naluLen
        }
    }
}

private let h264OutputCallback: VTCompressionOutputCallback = { refcon, _, status, _, sampleBuffer in
    guard status == noErr, let refcon = refcon, let sampleBuffer = sampleBuffer else { return }
    let encoder = Unmanaged<H264Encoder>.fromOpaque(refcon).takeUnretainedValue()
    encoder.handleEncodedSample(sampleBuffer)
}

final class VideoBridge: NSObject, SCStreamOutput, SCStreamDelegate {
    private let stateQueue = DispatchQueue(label: "com.bluebubbles.videobridge.state")
    private let captureQueue = DispatchQueue(label: "com.bluebubbles.videobridge.capture", qos: .userInteractive)
    private var stream: SCStream?
    private var encoder: H264Encoder?
    private var activeWindowID: CGWindowID?
    private var running = true
    private var acquiring = false
    private var reacquireDelay: TimeInterval = 0.5
    private var reacquireElapsed: TimeInterval = 0
    private let maxReacquireDelay: TimeInterval = 5.0
    private let maxReacquireWait: TimeInterval = 60.0

    func start() {
        log("Starting FaceTime video downlink bridge")
        startStdinMonitor()
        acquireLoop()
        dispatchMain()
    }

    private func startStdinMonitor() {
        DispatchQueue.global(qos: .utility).async { [weak self] in
            var byte: UInt8 = 0
            while true {
                let n = Darwin.read(STDIN_FILENO, &byte, 1)
                if n == 0 {
                    log("Stdin EOF; stopping")
                    self?.stop()
                    return
                }
                if n < 0 {
                    if errno == EINTR { continue }
                    log("Stdin read error (\(errno)); stopping")
                    self?.stop()
                    return
                }
            }
        }
    }

    func stop() {
        stateQueue.async {
            self.running = false
            self.teardownCaptureLocked()
            exit(0)
        }
    }

    private func teardownCaptureLocked() {
        if let activeStream = stream {
            stream = nil
            let stopDone = DispatchSemaphore(value: 0)
            activeStream.stopCapture { _ in
                stopDone.signal()
            }
            _ = stopDone.wait(timeout: .now() + 2.0)
        }
        captureQueue.sync {
            self.encoder?.invalidate()
            self.encoder = nil
        }
        activeWindowID = nil
    }

    private func acquireLoop() {
        stateQueue.async {
            guard self.running, self.stream == nil, !self.acquiring else { return }
            self.acquiring = true
            SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: true) { [weak self] content, error in
                guard let self = self else { return }
                self.stateQueue.async {
                    self.acquiring = false
                    guard self.running, self.stream == nil else { return }
                    if let error = error {
                        log("SCShareableContent error: \(error.localizedDescription)")
                        self.scheduleReacquireLocked()
                        return
                    }
                    guard let content = content, let window = self.selectFaceTimeWindow(from: content.windows) else {
                        self.scheduleReacquireLocked()
                        return
                    }
                    self.startCaptureLocked(window: window)
                }
            }
        }
    }

    private func scheduleReacquireLocked() {
        guard running else { return }
        if reacquireElapsed >= maxReacquireWait {
            log("Timed out waiting to reacquire FaceTime window after \(Int(maxReacquireWait))s; stopping")
            running = false
            teardownCaptureLocked()
            exit(0)
        }
        let delay = reacquireDelay
        reacquireElapsed += delay
        reacquireDelay = min(maxReacquireDelay, reacquireDelay * 2.0)
        stateQueue.asyncAfter(deadline: .now() + delay) { [weak self] in
            self?.acquireLoop()
        }
    }

    private func selectFaceTimeWindow(from windows: [SCWindow]) -> SCWindow? {
        let candidates = windows.filter { win in
            win.owningApplication?.bundleIdentifier == targetBundleID
                && win.isOnScreen
                && win.windowLayer == 0
                && win.frame.width >= 100
                && win.frame.height >= 100
        }
        return candidates.max { ($0.frame.width * $0.frame.height) < ($1.frame.width * $1.frame.height) }
    }

    private func startCaptureLocked(window: SCWindow) {
        let dims = scaledDimensions(for: window.frame)
        guard let enc = H264Encoder(width: dims.width, height: dims.height, onAccessUnit: { accessUnit in
            writeStdoutFrame(accessUnit)
        }) else {
            scheduleReacquireLocked()
            return
        }

        let filter = SCContentFilter(desktopIndependentWindow: window)
        let config = SCStreamConfiguration()
        config.width = dims.width
        config.height = dims.height
        config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(targetFPS))
        config.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
        config.showsCursor = false
        config.queueDepth = 3

        captureQueue.sync {
            self.encoder = enc
        }
        let newStream = SCStream(filter: filter, configuration: config, delegate: self)
        do {
            try newStream.addStreamOutput(self, type: .screen, sampleHandlerQueue: captureQueue)
        } catch {
            log("addStreamOutput failed: \(error.localizedDescription)")
            captureQueue.sync {
                self.encoder?.invalidate()
                self.encoder = nil
            }
            scheduleReacquireLocked()
            return
        }

        self.stream = newStream
        self.activeWindowID = window.windowID

        newStream.startCapture { [weak self] error in
            guard let self = self else { return }
            self.stateQueue.async {
                if let error = error {
                    log("startCapture failed: \(error.localizedDescription)")
                    self.teardownCaptureLocked()
                    self.scheduleReacquireLocked()
                } else {
                    self.reacquireDelay = 0.5
                    self.reacquireElapsed = 0
                    log("Capturing FaceTime window \(window.windowID) at \(dims.width)x\(dims.height)")
                }
            }
        }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, CMSampleBufferDataIsReady(sampleBuffer) else { return }
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        let dur = CMSampleBufferGetDuration(sampleBuffer)
        encoder?.encode(pixelBuffer: pixelBuffer, pts: pts, duration: dur.isValid ? dur : CMTime(value: 1, timescale: CMTimeScale(targetFPS)))
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        log("Stream stopped: \(error.localizedDescription); re-acquiring")
        stateQueue.async {
            self.teardownCaptureLocked()
            self.scheduleReacquireLocked()
        }
    }
}

private func parseAnnexBNALTypes(_ accessUnit: Data) -> [UInt8] {
    var types: [UInt8] = []
    let bytes = [UInt8](accessUnit)
    var i = 0
    while i + 4 < bytes.count {
        if bytes[i] == 0x00 && bytes[i + 1] == 0x00 && bytes[i + 2] == 0x00 && bytes[i + 3] == 0x01 {
            types.append(bytes[i + 4] & 0x1F)
            i += 4
        } else {
            i += 1
        }
    }
    return types
}

private func runSelfTest() -> Int32 {
    let width = 640
    let height = 360
    var emittedUnits: [Data] = []
    let lock = NSLock()

    guard let encoder = H264Encoder(width: width, height: height, onAccessUnit: { unit in
        lock.lock()
        emittedUnits.append(unit)
        lock.unlock()
    }) else {
        log("Self-test failed: could not create H264Encoder")
        return 1
    }

    let attrs: [CFString: Any] = [
        kCVPixelBufferCGImageCompatibilityKey: kCFBooleanTrue!,
        kCVPixelBufferCGBitmapContextCompatibilityKey: kCFBooleanTrue!,
    ]
    for idx in 0..<5 {
        var pb: CVPixelBuffer?
        let st = CVPixelBufferCreate(
            kCFAllocatorDefault,
            width,
            height,
            kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
            attrs as CFDictionary,
            &pb
        )
        guard st == kCVReturnSuccess, let pixelBuffer = pb else {
            log("Self-test failed: CVPixelBufferCreate returned \(st)")
            encoder.invalidate()
            return 1
        }
        CVPixelBufferLockBaseAddress(pixelBuffer, [])
        if let yPlane = CVPixelBufferGetBaseAddressOfPlane(pixelBuffer, 0) {
            let yBytes = CVPixelBufferGetBytesPerRowOfPlane(pixelBuffer, 0) * height
            memset(yPlane, Int32(16 + idx * 30), yBytes)
        }
        if let uvPlane = CVPixelBufferGetBaseAddressOfPlane(pixelBuffer, 1) {
            let uvBytes = CVPixelBufferGetBytesPerRowOfPlane(pixelBuffer, 1) * (height / 2)
            memset(uvPlane, 128, uvBytes)
        }
        CVPixelBufferUnlockBaseAddress(pixelBuffer, [])

        let pts = CMTime(value: CMTimeValue(idx), timescale: CMTimeScale(targetFPS))
        let dur = CMTime(value: 1, timescale: CMTimeScale(targetFPS))
        encoder.encode(pixelBuffer: pixelBuffer, pts: pts, duration: dur, forceKeyframe: idx == 0)
    }

    encoder.flush()
    encoder.invalidate()

    lock.lock()
    let units = emittedUnits
    lock.unlock()

    var sawSPS = false
    var sawPPS = false
    var sawIDR = false
    for unit in units {
        for nalType in parseAnnexBNALTypes(unit) {
            if nalType == 7 { sawSPS = true }
            if nalType == 8 { sawPPS = true }
            if nalType == 5 { sawIDR = true }
        }
    }

    if units.isEmpty || !sawSPS || !sawPPS || !sawIDR {
        log("Self-test failed: units=\(units.count) sps=\(sawSPS) pps=\(sawPPS) idr=\(sawIDR)")
        return 1
    }

    let totalBytes = units.reduce(0) { $0 + $1.count }
    let report = "{\"ok\":true,\"frames\":\(units.count),\"bytes\":\(totalBytes),\"sps\":\(sawSPS),\"pps\":\(sawPPS),\"idr\":\(sawIDR)}\n"
    FileHandle.standardOutput.write(Data(report.utf8))
    return 0
}

if CommandLine.arguments.contains("--self-test") {
    exit(runSelfTest())
}

let bridge = VideoBridge()
let sigQueue = DispatchQueue(label: "com.bluebubbles.videobridge.signals")
signal(SIGPIPE, SIG_IGN)
signal(SIGTERM, SIG_IGN)
signal(SIGINT, SIG_IGN)
let termSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: sigQueue)
termSource.setEventHandler { bridge.stop() }
termSource.resume()
let intSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: sigQueue)
intSource.setEventHandler { bridge.stop() }
intSource.resume()

bridge.start()
