import Accelerate
import CoreGraphics
import CoreMedia
import CoreVideo
import Foundation
import VideoToolbox

// Build: ./scripts/build-video-bridge.sh

private let maxWidth = 1920
private let maxHeight = 1080
private let defaultFPS = 30
private let initialBitrate = 1_800_000
private let maxBitrate = 4_500_000
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

private func canvasDimensions(
    for rect: CGRect,
    maxWidth: Int = maxWidth,
    maxHeight: Int = maxHeight
) -> (width: Int, height: Int) {
    let longEdge = Double(evenDimension(max(maxWidth, maxHeight), minimum: 64))
    let shortEdge = Double(evenDimension(min(maxWidth, maxHeight), minimum: 64))
    guard rect.width > 0, rect.height > 0 else {
        return (Int(longEdge), Int(shortEdge))
    }
    let isPortrait = rect.height > rect.width
    let boundW = isPortrait ? shortEdge : longEdge
    let boundH = isPortrait ? longEdge : shortEdge
    let scale = min(1.0, min(boundW / Double(rect.width), boundH / Double(rect.height)))
    let w = evenDimension(Int((Double(rect.width) * scale).rounded()), minimum: 64)
    let h = evenDimension(Int((Double(rect.height) * scale).rounded()), minimum: 64)
    return (w, h)
}

private func rotationDegrees(rawWidth: Int, rawHeight: Int, orientation: UInt32, hasOrientation: Bool) -> Int {
    guard hasOrientation else { return 0 }
    if rawWidth >= rawHeight {
        switch orientation & 0x03 {
        case 0: return 90   // Portrait from landscape sensor
        case 1: return 270  // PortraitUpsideDown from landscape sensor
        case 2: return 180  // LandscapeLeft
        default: return 0   // LandscapeRight
        }
    } else {
        switch orientation & 0x03 {
        case 0: return 0    // Already portrait
        case 1: return 180  // PortraitUpsideDown
        case 2: return 90   // LandscapeLeft from portrait buffer
        default: return 270 // LandscapeRight from portrait buffer
        }
    }
}

private func rotateNV12WithVImage(src: CVPixelBuffer, dst: CVPixelBuffer, degrees: Int) -> Bool {
    let vImageRot: UInt8
    switch degrees {
    case 90: vImageRot = UInt8(kRotate90DegreesClockwise)
    case 180: vImageRot = UInt8(kRotate180DegreesClockwise)
    case 270: vImageRot = UInt8(kRotate270DegreesClockwise)
    default: return false
    }
    guard CVPixelBufferLockBaseAddress(src, .readOnly) == kCVReturnSuccess else { return false }
    defer { CVPixelBufferUnlockBaseAddress(src, .readOnly) }
    guard CVPixelBufferLockBaseAddress(dst, []) == kCVReturnSuccess else { return false }
    defer { CVPixelBufferUnlockBaseAddress(dst, []) }

    guard let srcY = CVPixelBufferGetBaseAddressOfPlane(src, 0),
          let dstY = CVPixelBufferGetBaseAddressOfPlane(dst, 0),
          let srcUV = CVPixelBufferGetBaseAddressOfPlane(src, 1),
          let dstUV = CVPixelBufferGetBaseAddressOfPlane(dst, 1) else {
        return false
    }
    let srcW = CVPixelBufferGetWidth(src)
    let srcH = CVPixelBufferGetHeight(src)
    let dstW = CVPixelBufferGetWidth(dst)
    let dstH = CVPixelBufferGetHeight(dst)

    var sY = vImage_Buffer(data: srcY, height: vImagePixelCount(srcH), width: vImagePixelCount(srcW), rowBytes: CVPixelBufferGetBytesPerRowOfPlane(src, 0))
    var dY = vImage_Buffer(data: dstY, height: vImagePixelCount(dstH), width: vImagePixelCount(dstW), rowBytes: CVPixelBufferGetBytesPerRowOfPlane(dst, 0))
    if vImageRotate90_Planar8(&sY, &dY, vImageRot, 16, vImage_Flags(kvImageNoFlags)) != kvImageNoError {
        return false
    }

    var sUV = vImage_Buffer(data: srcUV, height: vImagePixelCount(srcH / 2), width: vImagePixelCount(srcW / 2), rowBytes: CVPixelBufferGetBytesPerRowOfPlane(src, 1))
    var dUV = vImage_Buffer(data: dstUV, height: vImagePixelCount(dstH / 2), width: vImagePixelCount(dstW / 2), rowBytes: CVPixelBufferGetBytesPerRowOfPlane(dst, 1))
    return vImageRotate90_Planar16U(&sUV, &dUV, vImageRot, 0x8080, vImage_Flags(kvImageNoFlags)) == kvImageNoError
}

private func hasAspectMismatch(
    contentRect: CGRect,
    activeWidth: Int,
    activeHeight: Int
) -> Bool {
    guard activeWidth > 0, activeHeight > 0, contentRect.width >= 16, contentRect.height >= 16 else {
        return false
    }
    let activePortrait = activeHeight > activeWidth
    let contentPortrait = contentRect.height > contentRect.width
    return activePortrait != contentPortrait
}

final class H264Encoder {
    private var session: VTCompressionSession?
    private let width: Int
    private let height: Int
    private let onAccessUnit: (Data) -> Void
    private var frameIndex: Int64 = 0
    // Force IDR + SPS/PPS on the first frame of every new encoder instance (including swaps).
    private var forceNextKeyframe = true

    init?(width: Int, height: Int, fps: Int = defaultFPS, bitrate: Int = initialBitrate, onAccessUnit: @escaping (Data) -> Void) {
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
        VTSessionSetProperty(vtSession, key: kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration, value: 2.0 as CFNumber)

        self.session = vtSession
        updateBitrate(bitrate)
        updateFrameRate(fps)

        let prepStatus = VTCompressionSessionPrepareToEncodeFrames(vtSession)
        if prepStatus != noErr {
            log("VTCompressionSessionPrepareToEncodeFrames warning: \(prepStatus)")
        }
    }

    func updateBitrate(_ bitrate: Int) {
        guard let vtSession = session else { return }
        let clamped = max(100_000, min(maxBitrate, bitrate))
        VTSessionSetProperty(vtSession, key: kVTCompressionPropertyKey_AverageBitRate, value: clamped as CFNumber)
        let bytesPerSec = max(16_000, Int(Double(clamped) * 1.35 / 8.0))
        let limits: [NSNumber] = [NSNumber(value: bytesPerSec), NSNumber(value: 1)]
        VTSessionSetProperty(vtSession, key: kVTCompressionPropertyKey_DataRateLimits, value: limits as CFArray)
    }

    func updateFrameRate(_ fps: Int) {
        guard let vtSession = session else { return }
        let clamped = max(5, min(30, fps))
        VTSessionSetProperty(vtSession, key: kVTCompressionPropertyKey_ExpectedFrameRate, value: clamped as CFNumber)
        VTSessionSetProperty(vtSession, key: kVTCompressionPropertyKey_MaxKeyFrameInterval, value: (clamped * 2) as CFNumber)
    }

    func requestKeyframe() {
        forceNextKeyframe = true
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
        let shouldForce = forceKeyframe || forceNextKeyframe
        forceNextKeyframe = false
        var props: [CFString: Any]?
        if shouldForce {
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

final class VideoBridge: NSObject {
    private let captureQueue = DispatchQueue(label: "com.bluebubbles.videobridge.capture", qos: .userInteractive)
    private var encoder: H264Encoder?
    private var captureActiveDims: (width: Int, height: Int) = (0, 0)

    // Direct decoded stream ring reader (/private/var/tmp/AVConference/bb-downlink.ring)
    private let downlinkRingPath = "/private/var/tmp/AVConference/bb-downlink.ring"
    private var ringTimer: DispatchSourceTimer?
    private var ringFd: Int32 = -1
    private var ringMap: UnsafeMutableRawPointer?
    private var ringMapSize: Int = 0
    private var ringLastSeq: UInt64 = 0
    private var ringIno: UInt64 = 0
    private var ringLastStatCheckNs: UInt64 = 0
    private var ringPool: CVPixelBufferPool?
    private var ringPoolDims: (width: Int, height: Int) = (0, 0)
    private var rotatedPool: CVPixelBufferPool?
    private var rotatedPoolDims: (width: Int, height: Int) = (0, 0)
    private var vtRotationSession: AnyObject?
    private var vtRotationDegrees: Int = 0
    private var ringLoggedActive = false
    private var ringMaxW = maxWidth
    private var ringMaxH = maxHeight
    private var ringFPS = defaultFPS
    private var ringBitrate = initialBitrate

    func start() {
        log("Starting FaceTime direct video downlink bridge")
        startStdinMonitor()
        startDownlinkRingReader()
        dispatchMain()
    }

    private func startStdinMonitor() {
        DispatchQueue.global(qos: .utility).async { [weak self] in
            var buf = [UInt8](repeating: 0, count: 4096)
            var lineBuf = Data()
            while true {
                let n = Darwin.read(STDIN_FILENO, &buf, buf.count)
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
                lineBuf.append(contentsOf: buf[0..<n])
                if lineBuf.count > 65_536 {
                    log("Stdin lineBuf exceeded 64KB; resetting buffer")
                    lineBuf.removeAll(keepingCapacity: false)
                }
                while let nlIdx = lineBuf.firstIndex(of: 0x0A) {
                    let lineData = lineBuf.subdata(in: lineBuf.startIndex..<nlIdx)
                    lineBuf.removeSubrange(lineBuf.startIndex...nlIdx)
                    if !lineData.isEmpty {
                        self?.handleStdinLine(lineData)
                    }
                }
            }
        }
    }

    private func handleStdinLine(_ data: Data) {
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let cmd = obj["cmd"] as? String else {
            return
        }
        if cmd == "idr" {
            captureQueue.async { [weak self] in
                self?.encoder?.requestKeyframe()
            }
        } else if cmd == "adapt" {
            let maxW = (obj["maxWidth"] as? NSNumber)?.intValue
            let maxH = (obj["maxHeight"] as? NSNumber)?.intValue
            let fps = (obj["fps"] as? NSNumber)?.intValue
            let bitrate = (obj["bitrate"] as? NSNumber)?.intValue
            captureQueue.async { [weak self] in
                guard let self = self else { return }
                if let w = maxW { self.ringMaxW = max(160, min(maxWidth, w)) }
                if let h = maxH { self.ringMaxH = max(160, min(maxHeight, h)) }
                if let f = fps {
                    self.ringFPS = max(5, min(30, f))
                    self.encoder?.updateFrameRate(self.ringFPS)
                }
                if let b = bitrate {
                    self.ringBitrate = max(100_000, min(maxBitrate, b))
                    self.encoder?.updateBitrate(self.ringBitrate)
                }
            }
        }
    }

    func stop() {
        captureQueue.async {
            self.ringTimer?.cancel()
            self.ringTimer = nil
            self.unmapDownlinkRing()
            self.encoder?.invalidate()
            self.encoder = nil
            exit(0)
        }
    }

    private static let timebase: (numer: UInt64, denom: UInt64) = {
        var tb = mach_timebase_info_data_t(numer: 0, denom: 0)
        mach_timebase_info(&tb)
        return (UInt64(tb.numer), UInt64(max(1, tb.denom)))
    }()

    private static func nowNanoseconds() -> UInt64 {
        let t = mach_continuous_time()
        return (UInt64(t) * timebase.numer) / timebase.denom
    }

    private func unmapDownlinkRing() {
        if let ptr = ringMap {
            munmap(ptr, ringMapSize)
            ringMap = nil
            ringMapSize = 0
        }
        if ringFd >= 0 {
            close(ringFd)
            ringFd = -1
        }
        ringLastSeq = 0
        ringIno = 0
    }

    private func startDownlinkRingReader() {
        let timer = DispatchSource.makeTimerSource(queue: captureQueue)
        timer.schedule(deadline: .now() + .milliseconds(8), repeating: .milliseconds(8), leeway: .milliseconds(2))
        timer.setEventHandler { [weak self] in
            self?.pollDownlinkRingOnCaptureQueue()
        }
        ringTimer = timer
        timer.resume()
    }

    private func pollDownlinkRingOnCaptureQueue() {
        if ringMap == nil {
            let fd = open(downlinkRingPath, O_RDONLY)
            if fd < 0 { return }
            var st = stat()
            if fstat(fd, &st) != 0 || st.st_size < 64 {
                close(fd)
                return
            }
            let size = Int(st.st_size)
            let ptr = mmap(nil, size, PROT_READ, MAP_SHARED, fd, 0)
            if ptr == MAP_FAILED || ptr == nil {
                close(fd)
                return
            }
            ringFd = fd
            ringMap = ptr
            ringMapSize = size
            ringLastSeq = 0
            ringIno = UInt64(st.st_ino)
            ringLastStatCheckNs = Self.nowNanoseconds()
        }
        guard let base = ringMap else { return }

        let seq = base.load(fromByteOffset: 24, as: UInt64.self)
        OSMemoryBarrier()
        let magic = base.load(fromByteOffset: 0, as: UInt32.self)
        let version = base.load(fromByteOffset: 4, as: UInt32.self)
        let width = Int(base.load(fromByteOffset: 8, as: UInt32.self))
        let height = Int(base.load(fromByteOffset: 12, as: UInt32.self))
        let stride = Int(base.load(fromByteOffset: 16, as: UInt32.self))
        let format = base.load(fromByteOffset: 20, as: UInt32.self)
        let tsNs = base.load(fromByteOffset: 32, as: UInt64.self)
        let slots = Int(base.load(fromByteOffset: 40, as: UInt32.self))
        let slotBytes = Int(base.load(fromByteOffset: 44, as: UInt32.self))
        let orientation = base.load(fromByteOffset: 48, as: UInt32.self)
        let flags = base.load(fromByteOffset: 52, as: UInt32.self)
        let hasOrientation = (flags & 1) != 0

        let nowNs = Self.nowNanoseconds()
        if seq == 0 || (seq & 1) != 0 || seq == ringLastSeq {
            if nowNs >= ringLastStatCheckNs + 1_000_000_000 {
                ringLastStatCheckNs = nowNs
                var diskSt = stat()
                if stat(downlinkRingPath, &diskSt) == 0 && UInt64(diskSt.st_ino) != ringIno {
                    unmapDownlinkRing()
                }
            }
            return
        }

        guard magic == 0x42424352, version == 1,
              format == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
              slots >= 1, slotBytes > 0,
              width >= 2, height >= 2, width <= 1920, height <= 1920,
              stride >= width else {
            return
        }

        let (totalRows, ovRows) = height.addingReportingOverflow(height / 2)
        guard !ovRows else { return }
        let (needed, ovNeeded) = stride.multipliedReportingOverflow(by: totalRows)
        guard !ovNeeded, needed <= slotBytes else { return }

        let slotIdx = Int(seq % UInt64(slots))
        let (slotOffsetBytes, ovSlotBytes) = slotIdx.multipliedReportingOverflow(by: slotBytes)
        guard !ovSlotBytes else { return }
        let (slotOffset, ovOffset) = 64.addingReportingOverflow(slotOffsetBytes)
        guard !ovOffset else { return }
        let (endOffset, ovEnd) = slotOffset.addingReportingOverflow(needed)
        guard !ovEnd, endOffset <= ringMapSize else {
            unmapDownlinkRing()
            return
        }

        let ageNs = nowNs >= tsNs ? (nowNs - tsNs) : 0
        if ageNs > 1_500_000_000 {
            var diskSt = stat()
            if stat(downlinkRingPath, &diskSt) == 0 && UInt64(diskSt.st_ino) != ringIno {
                unmapDownlinkRing()
            }
            return
        }

        if ringPool == nil || ringPoolDims != (width, height) {
            ringPool = nil
            let attrs: [CFString: Any] = [
                kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
                kCVPixelBufferWidthKey: width,
                kCVPixelBufferHeightKey: height,
                kCVPixelBufferIOSurfacePropertiesKey: [:],
            ]
            var newPool: CVPixelBufferPool?
            if CVPixelBufferPoolCreate(kCFAllocatorDefault, nil, attrs as CFDictionary, &newPool) != kCVReturnSuccess || newPool == nil {
                return
            }
            ringPool = newPool
            ringPoolDims = (width, height)
        }
        guard let pool = ringPool else { return }
        var pbOpt: CVPixelBuffer?
        guard CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pool, &pbOpt) == kCVReturnSuccess,
              let pb = pbOpt else {
            return
        }
        guard CVPixelBufferLockBaseAddress(pb, []) == kCVReturnSuccess else { return }
        let slotPtr = base.advanced(by: slotOffset)
        if let yDst = CVPixelBufferGetBaseAddressOfPlane(pb, 0) {
            let yDstBpr = CVPixelBufferGetBytesPerRowOfPlane(pb, 0)
            for row in 0..<height {
                memcpy(yDst.advanced(by: row * yDstBpr), slotPtr.advanced(by: row * stride), width)
            }
        }
        if let uvDst = CVPixelBufferGetBaseAddressOfPlane(pb, 1) {
            let uvDstBpr = CVPixelBufferGetBytesPerRowOfPlane(pb, 1)
            let uvSrc = slotPtr.advanced(by: height * stride)
            for row in 0..<(height / 2) {
                memcpy(uvDst.advanced(by: row * uvDstBpr), uvSrc.advanced(by: row * stride), width)
            }
        }
        CVPixelBufferUnlockBaseAddress(pb, [])

        OSMemoryBarrier()
        let seqAfter = base.load(fromByteOffset: 24, as: UInt64.self)
        if seqAfter != seq {
            return
        }
        ringLastSeq = seq
        ringLastStatCheckNs = nowNs
        if !ringLoggedActive {
            ringLoggedActive = true
            log("Using direct decoded FaceTime stream (\(width)x\(height)) instead of screen capture")
        }

        let rotDeg = rotationDegrees(rawWidth: width, rawHeight: height, orientation: orientation, hasOrientation: hasOrientation)
        let (encodedPb, rotW, rotH) = rotatePixelBufferIfNeeded(pb, width: width, height: height, degrees: rotDeg)

        let targetDims = canvasDimensions(
            for: CGRect(x: 0, y: 0, width: rotW, height: rotH),
            maxWidth: ringMaxW,
            maxHeight: ringMaxH
        )
        if encoder == nil || captureActiveDims != targetDims {
            encoder?.invalidate()
            guard let enc = H264Encoder(
                width: targetDims.width,
                height: targetDims.height,
                fps: ringFPS,
                bitrate: ringBitrate,
                onAccessUnit: { accessUnit in
                    writeStdoutFrame(accessUnit)
                }
            ) else {
                encoder = nil
                captureActiveDims = (0, 0)
                return
            }
            enc.requestKeyframe()
            encoder = enc
            captureActiveDims = targetDims
        }
        let pts = CMTime(value: Int64(tsNs), timescale: 1_000_000_000)
        let dur = CMTime(value: 1, timescale: CMTimeScale(max(5, min(30, ringFPS))))
        encoder?.encode(pixelBuffer: encodedPb, pts: pts, duration: dur)
    }

    private func rotatePixelBufferIfNeeded(_ src: CVPixelBuffer, width: Int, height: Int, degrees: Int) -> (CVPixelBuffer, Int, Int) {
        guard degrees != 0 else { return (src, width, height) }
        let dstW = (degrees == 90 || degrees == 270) ? height : width
        let dstH = (degrees == 90 || degrees == 270) ? width : height

        if rotatedPool == nil || rotatedPoolDims != (dstW, dstH) {
            rotatedPool = nil
            let attrs: [CFString: Any] = [
                kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
                kCVPixelBufferWidthKey: dstW,
                kCVPixelBufferHeightKey: dstH,
                kCVPixelBufferIOSurfacePropertiesKey: [:],
            ]
            var newPool: CVPixelBufferPool?
            if CVPixelBufferPoolCreate(kCFAllocatorDefault, nil, attrs as CFDictionary, &newPool) != kCVReturnSuccess || newPool == nil {
                return (src, width, height)
            }
            rotatedPool = newPool
            rotatedPoolDims = (dstW, dstH)
        }
        guard let pool = rotatedPool else { return (src, width, height) }
        var dstOpt: CVPixelBuffer?
        guard CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pool, &dstOpt) == kCVReturnSuccess,
              let dst = dstOpt else {
            return (src, width, height)
        }

        if #available(macOS 13.0, *) {
            if vtRotationSession == nil || vtRotationDegrees != degrees {
                if let existing = vtRotationSession {
                    VTPixelRotationSessionInvalidate(existing as! VTPixelRotationSession)
                    vtRotationSession = nil
                }
                var created: VTPixelRotationSession?
                if VTPixelRotationSessionCreate(kCFAllocatorDefault, &created) == noErr, let sess = created {
                    let rotProp: CFString
                    switch degrees {
                    case 90: rotProp = kVTRotation_CW90
                    case 180: rotProp = kVTRotation_180
                    default: rotProp = kVTRotation_CCW90
                    }
                    VTSessionSetProperty(sess, key: kVTPixelRotationPropertyKey_Rotation, value: rotProp)
                    vtRotationSession = sess
                    vtRotationDegrees = degrees
                }
            }
            if let sess = vtRotationSession,
               VTPixelRotationSessionRotateImage(sess as! VTPixelRotationSession, src, dst) == noErr {
                return (dst, dstW, dstH)
            }
        }

        if rotateNV12WithVImage(src: src, dst: dst, degrees: degrees) {
            return (dst, dstW, dstH)
        }
        return (src, width, height)
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

        let pts = CMTime(value: CMTimeValue(idx), timescale: CMTimeScale(defaultFPS))
        let dur = CMTime(value: 1, timescale: CMTimeScale(defaultFPS))
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

    let landscapeDimsA = canvasDimensions(for: CGRect(x: 0, y: 0, width: 1280, height: 720), maxWidth: 1280, maxHeight: 720)
    let portraitDims = canvasDimensions(for: CGRect(x: 0, y: 0, width: 720, height: 1280), maxWidth: 1280, maxHeight: 720)
    let ipadDims = canvasDimensions(for: CGRect(x: 0, y: 0, width: 1280, height: 960), maxWidth: 1280, maxHeight: 720)
    guard landscapeDimsA == (1280, 720),
          portraitDims == (720, 1280),
          ipadDims == (960, 720),
          rotationDegrees(rawWidth: 1280, rawHeight: 720, orientation: 0, hasOrientation: true) == 90,
          rotationDegrees(rawWidth: 1280, rawHeight: 720, orientation: 3, hasOrientation: true) == 0,
          rotationDegrees(rawWidth: 1280, rawHeight: 720, orientation: 0, hasOrientation: false) == 0 else {
        log("Self-test failed: canvasDimensions or rotationDegrees check failed")
        return 1
    }

    // Verify NV12 rotation (64x32 -> 32x64)
    var srcRotPb: CVPixelBuffer?
    var dstRotPb: CVPixelBuffer?
    guard CVPixelBufferCreate(kCFAllocatorDefault, 64, 32, kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange, attrs as CFDictionary, &srcRotPb) == kCVReturnSuccess,
          CVPixelBufferCreate(kCFAllocatorDefault, 32, 64, kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange, attrs as CFDictionary, &dstRotPb) == kCVReturnSuccess,
          let sRot = srcRotPb, let dRot = dstRotPb,
          rotateNV12WithVImage(src: sRot, dst: dRot, degrees: 90) else {
        log("Self-test failed: NV12 rotation check failed")
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
