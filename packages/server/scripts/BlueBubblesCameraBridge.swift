import AVFoundation
import CoreMedia
import CoreVideo
import Darwin
import Foundation
import VideoToolbox

// Build: ./scripts/build-video-bridge.sh

private let defaultRingPath = "/private/var/tmp/AVConference/bb-camera.ring"
private let ringDirPath = "/private/var/tmp/AVConference"
private let ringMagic: UInt32 = 0x42424352 // 'BBCR'
private let ringVersion: UInt32 = 1
private let ringPixelFormat: UInt32 = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange // '420v' = 0x34323076
private let ringSlots: UInt32 = 3
private let maxRingDim = 1920
private let maxRingPixels = 1920 * 1080
private let maxSlotBytes = maxRingPixels * 3 / 2 // 3,110,400 bytes
private let ringHeaderSize = 64
private let ringTotalSize = ringHeaderSize + Int(ringSlots) * maxSlotBytes
private let maxInputFrameBytes = 4 * 1024 * 1024
private let targetFPS: Int32 = 30

private func log(_ msg: String) {
    fputs("[BlueBubblesCameraBridge] \(msg)\n", stderr)
}

private struct RingHeader {
    var magic: UInt32
    var version: UInt32
    var width: UInt32
    var height: UInt32
    var stride: UInt32
    var format: UInt32
    var seq: UInt64
    var ts_ns: UInt64
    var slots: UInt32
    var slot_bytes: UInt32
    var reserved0: UInt64
    var reserved1: UInt64
}

private let timebaseInfo: mach_timebase_info_data_t = {
    var info = mach_timebase_info_data_t()
    mach_timebase_info(&info)
    return info
}()

private func machContinuousTimeNs() -> UInt64 {
    let ticks = mach_continuous_time()
    let numer = UInt64(timebaseInfo.numer)
    let denom = UInt64(max(1, timebaseInfo.denom))
    if numer == denom {
        return ticks
    }
    let (high, low) = ticks.multipliedFullWidth(by: numer)
    return denom.dividingFullWidth((high: high, low: low)).quotient
}

@_silgen_name("OSMemoryBarrier")
private func memoryBarrier()

final class CameraRingWriter {
    private let path: String
    private let lock = NSLock()
    private var closed = false
    private var fd: Int32 = -1
    private var mappedBase: UnsafeMutableRawPointer?
    private var transferSession: VTPixelTransferSession?
    private var scaledBuffer: CVPixelBuffer?
    private var scaledWidth = 0
    private var scaledHeight = 0

    private static func ensureSafeRingDir(_ dir: String) -> Bool {
        let uid = getuid()
        var st = stat()
        if lstat(dir, &st) == 0 {
            let fileType = st.st_mode & S_IFMT
            if fileType == S_IFLNK || fileType != S_IFDIR {
                log("Ring directory \(dir) is not a directory or is a symlink")
                return false
            }
            if st.st_uid != uid {
                log("Ring directory \(dir) UID mismatch: expected \(uid), got \(st.st_uid)")
                return false
            }
        } else {
            do {
                try FileManager.default.createDirectory(
                    atPath: dir,
                    withIntermediateDirectories: true,
                    attributes: [.posixPermissions: 0o755]
                )
                chmod(dir, 0o755)
            } catch {
                log("Failed to create ring directory \(dir): \(error.localizedDescription)")
                return false
            }
            if lstat(dir, &st) != 0 {
                log("lstat failed for ring directory \(dir): errno=\(errno)")
                return false
            }
            let fileType = st.st_mode & S_IFMT
            guard fileType == S_IFDIR, st.st_uid == uid else {
                log("Unsafe ring directory \(dir)")
                return false
            }
        }
        return true
    }

    private static func sweepStaleTempFiles(in dir: String, prefix: String) {
        guard let files = try? FileManager.default.contentsOfDirectory(atPath: dir) else { return }
        let uid = getuid()
        for file in files where file.hasPrefix(prefix) {
            let fullPath = (dir as NSString).appendingPathComponent(file)
            var st = stat()
            guard lstat(fullPath, &st) == 0, (st.st_mode & S_IFMT) == S_IFREG, st.st_uid == uid else { continue }
            let suffix = String(file.dropFirst(prefix.count))
            if let pid = pid_t(suffix) {
                // If process is dead, reap orphaned temp ring
                if kill(pid, 0) != 0 && errno == ESRCH {
                    unlink(fullPath)
                }
            } else {
                unlink(fullPath)
            }
        }
    }

    init?(path: String = defaultRingPath) {
        self.path = path
        assert(MemoryLayout<RingHeader>.size == ringHeaderSize)

        let dir = (path as NSString).deletingLastPathComponent
        guard Self.ensureSafeRingDir(dir) else {
            return nil
        }
        let filePrefix = (path as NSString).lastPathComponent + ".tmp."
        Self.sweepStaleTempFiles(in: dir, prefix: filePrefix)

        let uid = getuid()
        // Always recreate via temp+rename so stale rings are replaced without ftruncate SIGBUS on active readers
        let tmpPath = "\(path).tmp.\(getpid())"
        unlink(tmpPath)
        let opened = open(tmpPath, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW, 0o644)
        guard opened >= 0 else {
            log("Failed to open temp ring file \(tmpPath): errno=\(errno)")
            return nil
        }
        fchmod(opened, 0o644)

        var st = stat()
        guard fstat(opened, &st) == 0, (st.st_mode & S_IFMT) == S_IFREG, st.st_uid == uid else {
            log("fstat failed for temp ring file \(tmpPath): errno=\(errno)")
            close(opened)
            unlink(tmpPath)
            return nil
        }

        if ftruncate(opened, off_t(ringTotalSize)) != 0 {
            log("ftruncate failed for \(tmpPath): errno=\(errno)")
            close(opened)
            unlink(tmpPath)
            return nil
        }

        let ptr = mmap(nil, ringTotalSize, PROT_READ | PROT_WRITE, MAP_SHARED, opened, 0)
        guard ptr != MAP_FAILED, let base = ptr else {
            log("mmap failed for \(tmpPath): errno=\(errno)")
            close(opened)
            unlink(tmpPath)
            return nil
        }

        self.fd = opened
        self.mappedBase = base
        initializeHeaderIfNeeded()

        if rename(tmpPath, path) != 0 {
            log("rename failed for \(path): errno=\(errno)")
            munmap(base, ringTotalSize)
            self.mappedBase = nil
            close(opened)
            self.fd = -1
            unlink(tmpPath)
            return nil
        }
    }

    deinit {
        if let session = transferSession {
            VTPixelTransferSessionInvalidate(session)
            transferSession = nil
        }
        if let base = mappedBase {
            munmap(base, ringTotalSize)
            mappedBase = nil
        }
        if fd >= 0 {
            close(fd)
            fd = -1
        }
    }

    private var headerPtr: UnsafeMutablePointer<RingHeader>? {
        mappedBase?.assumingMemoryBound(to: RingHeader.self)
    }

    private func initializeHeaderIfNeeded() {
        guard let hdr = headerPtr else { return }
        let existingValid = hdr.pointee.magic == ringMagic
            && hdr.pointee.version == ringVersion
            && hdr.pointee.slots == ringSlots
            && hdr.pointee.slot_bytes == UInt32(maxSlotBytes)

        if existingValid {
            if (hdr.pointee.seq & 1) != 0 {
                hdr.pointee.seq &+= 1
            }
            hdr.pointee.format = ringPixelFormat
            memoryBarrier()
            return
        }

        memset(mappedBase, 0, ringHeaderSize)
        hdr.pointee.magic = ringMagic
        hdr.pointee.version = ringVersion
        hdr.pointee.format = ringPixelFormat
        hdr.pointee.slots = ringSlots
        hdr.pointee.slot_bytes = UInt32(maxSlotBytes)
        hdr.pointee.seq = 0
        hdr.pointee.ts_ns = 0
        memoryBarrier()
    }

    func readHeaderSnapshot() -> (magic: UInt32, version: UInt32, width: UInt32, height: UInt32, stride: UInt32, format: UInt32, seq: UInt64, tsNs: UInt64, slots: UInt32, slotBytes: UInt32)? {
        guard let hdr = headerPtr else { return nil }
        memoryBarrier()
        return (
            hdr.pointee.magic,
            hdr.pointee.version,
            hdr.pointee.width,
            hdr.pointee.height,
            hdr.pointee.stride,
            hdr.pointee.format,
            hdr.pointee.seq,
            hdr.pointee.ts_ns,
            hdr.pointee.slots,
            hdr.pointee.slot_bytes
        )
    }

    func readSlotBytes(slotIndex: Int, count: Int) -> Data? {
        guard let base = mappedBase, slotIndex >= 0, slotIndex < Int(ringSlots), count > 0, count <= maxSlotBytes else {
            return nil
        }
        let ptr = base.advanced(by: ringHeaderSize + slotIndex * maxSlotBytes)
        return Data(bytes: ptr, count: count)
    }

    func clear(markClosed: Bool = false) {
        lock.lock()
        defer { lock.unlock() }
        if markClosed {
            closed = true
        }
        guard let hdr = headerPtr else { return }
        var s = hdr.pointee.seq
        if (s & 1) != 0 {
            s &+= 1
        }
        let oddSeq = s &+ 1
        hdr.pointee.seq = oddSeq
        memoryBarrier()
        hdr.pointee.ts_ns = 0
        memoryBarrier()
        hdr.pointee.seq = oddSeq &+ 1
        memoryBarrier()
    }

    func writeFrame(pixelBuffer: CVPixelBuffer) {
        lock.lock()
        defer { lock.unlock() }
        guard !closed, let base = mappedBase, let hdr = headerPtr else { return }

        let sourceBuffer = prepareFitBuffer(pixelBuffer)
        let width = CVPixelBufferGetWidth(sourceBuffer) & ~1
        let height = CVPixelBufferGetHeight(sourceBuffer) & ~1
        guard width >= 2, height >= 2, width <= maxRingDim, height <= maxRingDim, width * height <= maxRingPixels else { return }
        guard CVPixelBufferGetPlaneCount(sourceBuffer) >= 2 else { return }

        let stride = width
        let yPlaneBytes = stride * height
        let uvPlaneBytes = stride * (height / 2)
        guard yPlaneBytes + uvPlaneBytes <= maxSlotBytes else { return }

        CVPixelBufferLockBaseAddress(sourceBuffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(sourceBuffer, .readOnly) }

        guard let srcYBase = CVPixelBufferGetBaseAddressOfPlane(sourceBuffer, 0),
              let srcUVBase = CVPixelBufferGetBaseAddressOfPlane(sourceBuffer, 1) else {
            return
        }
        let srcYStride = CVPixelBufferGetBytesPerRowOfPlane(sourceBuffer, 0)
        let srcUVStride = CVPixelBufferGetBytesPerRowOfPlane(sourceBuffer, 1)
        guard srcYStride >= width, srcUVStride >= width else { return }

        var s = hdr.pointee.seq
        if (s & 1) != 0 {
            s &+= 1
        }
        let oddSeq = s &+ 1
        hdr.pointee.seq = oddSeq
        memoryBarrier()

        let slotIndex = Int((oddSeq / 2) % UInt64(ringSlots))
        let slotPtr = base.advanced(by: ringHeaderSize + slotIndex * maxSlotBytes)

        if srcYStride == stride {
            memcpy(slotPtr, srcYBase, yPlaneBytes)
        } else {
            for row in 0..<height {
                memcpy(
                    slotPtr.advanced(by: row * stride),
                    srcYBase.advanced(by: row * srcYStride),
                    width
                )
            }
        }

        let dstUVPtr = slotPtr.advanced(by: yPlaneBytes)
        let uvRows = height / 2
        if srcUVStride == stride {
            memcpy(dstUVPtr, srcUVBase, uvPlaneBytes)
        } else {
            for row in 0..<uvRows {
                memcpy(
                    dstUVPtr.advanced(by: row * stride),
                    srcUVBase.advanced(by: row * srcUVStride),
                    width
                )
            }
        }

        hdr.pointee.width = UInt32(width)
        hdr.pointee.height = UInt32(height)
        hdr.pointee.stride = UInt32(stride)
        hdr.pointee.format = ringPixelFormat
        hdr.pointee.ts_ns = machContinuousTimeNs()
        memoryBarrier()

        hdr.pointee.seq = oddSeq &+ 1
        memoryBarrier()
    }

    private func prepareFitBuffer(_ pixelBuffer: CVPixelBuffer) -> CVPixelBuffer {
        let srcW = CVPixelBufferGetWidth(pixelBuffer)
        let srcH = CVPixelBufferGetHeight(pixelBuffer)
        let fmt = CVPixelBufferGetPixelFormatType(pixelBuffer)
        if srcW <= maxRingDim && srcH <= maxRingDim && srcW * srcH <= maxRingPixels && fmt == ringPixelFormat {
            return pixelBuffer
        }

        let boxW = srcW >= srcH ? 1920 : 1080
        let boxH = srcW >= srcH ? 1080 : 1920
        let scale = min(1.0, min(Double(boxW) / Double(max(1, srcW)), Double(boxH) / Double(max(1, srcH))))
        let dstW = max(2, Int(Double(srcW) * scale) & ~1)
        let dstH = max(2, Int(Double(srcH) * scale) & ~1)

        if transferSession == nil {
            var created: VTPixelTransferSession?
            if VTPixelTransferSessionCreate(allocator: nil, pixelTransferSessionOut: &created) == noErr {
                transferSession = created
            }
        }
        guard let session = transferSession else {
            return pixelBuffer
        }

        if scaledBuffer == nil || scaledWidth != dstW || scaledHeight != dstH {
            var pb: CVPixelBuffer?
            let st = CVPixelBufferCreate(
                kCFAllocatorDefault,
                dstW,
                dstH,
                ringPixelFormat,
                nil,
                &pb
            )
            guard st == kCVReturnSuccess, let newPB = pb else {
                return pixelBuffer
            }
            scaledBuffer = newPB
            scaledWidth = dstW
            scaledHeight = dstH
        }

        guard let dstBuffer = scaledBuffer else { return pixelBuffer }
        let status = VTPixelTransferSessionTransferImage(session, from: pixelBuffer, to: dstBuffer)
        return status == noErr ? dstBuffer : pixelBuffer
    }
}

final class H264Decoder {
    private let lock = NSLock()
    private var invalidated = false
    private var decompressionSession: VTDecompressionSession?
    private var formatDescription: CMVideoFormatDescription?
    private var latestSPS: Data?
    private var latestPPS: Data?
    private var activeSPS: Data?
    private var activePPS: Data?
    private var frameCounter: Int64 = 0
    private let onDecodedFrame: (CVPixelBuffer) -> Void

    init(onDecodedFrame: @escaping (CVPixelBuffer) -> Void) {
        self.onDecodedFrame = onDecodedFrame
    }

    deinit {
        if let existing = decompressionSession {
            VTDecompressionSessionWaitForAsynchronousFrames(existing)
            VTDecompressionSessionInvalidate(existing)
            decompressionSession = nil
        }
        formatDescription = nil
        activeSPS = nil
        activePPS = nil
    }

    func invalidate() {
        lock.lock()
        invalidated = true
        let session = decompressionSession
        decompressionSession = nil
        formatDescription = nil
        activeSPS = nil
        activePPS = nil
        frameCounter = 0
        lock.unlock()
        if let session = session {
            VTDecompressionSessionWaitForAsynchronousFrames(session)
            VTDecompressionSessionInvalidate(session)
        }
    }

    func decodeAccessUnit(_ accessUnit: Data) {
        let nalus = splitAnnexBNalus(accessUnit)
        guard !nalus.isEmpty else { return }

        var vclNalus: [Data] = []
        for nalu in nalus {
            guard let firstByte = nalu.first else { continue }
            let nalType = firstByte & 0x1F
            switch nalType {
            case 7:
                latestSPS = nalu
            case 8:
                latestPPS = nalu
            case 1...5:
                vclNalus.append(nalu)
            default:
                break
            }
        }

        lock.lock()
        defer { lock.unlock() }
        if invalidated {
            return
        }
        if let sps = latestSPS, let pps = latestPPS {
            if decompressionSession == nil || sps != activeSPS || pps != activePPS {
                if !configureSession(sps: sps, pps: pps) {
                    return
                }
            }
        }

        guard !vclNalus.isEmpty,
              let session = decompressionSession,
              let fmtDesc = formatDescription else {
            return
        }

        var avccData = Data()
        avccData.reserveCapacity(accessUnit.count + vclNalus.count * 4)
        for nalu in vclNalus {
            var lenBE = UInt32(nalu.count).bigEndian
            withUnsafeBytes(of: &lenBE) { avccData.append(contentsOf: $0) }
            avccData.append(nalu)
        }

        var blockBuffer: CMBlockBuffer?
        let createStatus = CMBlockBufferCreateWithMemoryBlock(
            allocator: kCFAllocatorDefault,
            memoryBlock: nil,
            blockLength: avccData.count,
            blockAllocator: kCFAllocatorDefault,
            customBlockSource: nil,
            offsetToData: 0,
            dataLength: avccData.count,
            flags: kCMBlockBufferAssureMemoryNowFlag,
            blockBufferOut: &blockBuffer
        )
        guard createStatus == kCMBlockBufferNoErr, let block = blockBuffer else {
            log("CMBlockBufferCreateWithMemoryBlock failed: \(createStatus)")
            return
        }

        let replaceStatus = avccData.withUnsafeBytes { rawBuf -> OSStatus in
            guard let base = rawBuf.baseAddress else { return -1 }
            return CMBlockBufferReplaceDataBytes(
                with: base,
                blockBuffer: block,
                offsetIntoDestination: 0,
                dataLength: avccData.count
            )
        }
        guard replaceStatus == kCMBlockBufferNoErr else {
            log("CMBlockBufferReplaceDataBytes failed: \(replaceStatus)")
            return
        }

        var sampleBuffer: CMSampleBuffer?
        var sampleSize = avccData.count
        let pts = CMTime(value: frameCounter, timescale: targetFPS)
        frameCounter &+= 1
        var timing = CMSampleTimingInfo(
            duration: CMTime(value: 1, timescale: targetFPS),
            presentationTimeStamp: pts,
            decodeTimeStamp: .invalid
        )
        let sbStatus = CMSampleBufferCreateReady(
            allocator: kCFAllocatorDefault,
            dataBuffer: block,
            formatDescription: fmtDesc,
            sampleCount: 1,
            sampleTimingEntryCount: 1,
            sampleTimingArray: &timing,
            sampleSizeEntryCount: 1,
            sampleSizeArray: &sampleSize,
            sampleBufferOut: &sampleBuffer
        )
        guard sbStatus == noErr, let sb = sampleBuffer else {
            log("CMSampleBufferCreateReady failed: \(sbStatus)")
            return
        }

        let decodeStatus = VTDecompressionSessionDecodeFrame(
            session,
            sampleBuffer: sb,
            flags: [],
            frameRefcon: nil,
            infoFlagsOut: nil
        )
        if decodeStatus != noErr {
            log("VTDecompressionSessionDecodeFrame failed: \(decodeStatus)")
        }
    }

    private func configureSession(sps: Data, pps: Data) -> Bool {
        var newFormatDesc: CMVideoFormatDescription?
        let fmtStatus: OSStatus = sps.withUnsafeBytes { spsRaw in
            pps.withUnsafeBytes { ppsRaw in
                guard let spsPtr = spsRaw.bindMemory(to: UInt8.self).baseAddress,
                      let ppsPtr = ppsRaw.bindMemory(to: UInt8.self).baseAddress else {
                    return -1
                }
                var ptrs: [UnsafePointer<UInt8>] = [spsPtr, ppsPtr]
                var sizes: [Int] = [sps.count, pps.count]
                return ptrs.withUnsafeMutableBufferPointer { ptrBuf in
                    sizes.withUnsafeMutableBufferPointer { sizeBuf in
                        CMVideoFormatDescriptionCreateFromH264ParameterSets(
                            allocator: kCFAllocatorDefault,
                            parameterSetCount: 2,
                            parameterSetPointers: ptrBuf.baseAddress!,
                            parameterSetSizes: sizeBuf.baseAddress!,
                            nalUnitHeaderLength: 4,
                            formatDescriptionOut: &newFormatDesc
                        )
                    }
                }
            }
        }

        guard fmtStatus == noErr, let fmtDesc = newFormatDesc else {
            log("CMVideoFormatDescriptionCreateFromH264ParameterSets failed: \(fmtStatus)")
            return false
        }

        if let existing = decompressionSession,
           VTDecompressionSessionCanAcceptFormatDescription(existing, formatDescription: fmtDesc) {
            formatDescription = fmtDesc
            activeSPS = sps
            activePPS = pps
            return true
        }

        if let existing = decompressionSession {
            VTDecompressionSessionWaitForAsynchronousFrames(existing)
            VTDecompressionSessionInvalidate(existing)
            decompressionSession = nil
        }
        formatDescription = nil
        activeSPS = nil
        activePPS = nil

        let destAttrs: [CFString: Any] = [
            kCVPixelBufferPixelFormatTypeKey: ringPixelFormat
        ]
        var callbackRecord = VTDecompressionOutputCallbackRecord(
            decompressionOutputCallback: h264DecodeOutputCallback,
            decompressionOutputRefCon: Unmanaged.passUnretained(self).toOpaque()
        )
        var created: VTDecompressionSession?
        let status = VTDecompressionSessionCreate(
            allocator: kCFAllocatorDefault,
            formatDescription: fmtDesc,
            decoderSpecification: nil,
            imageBufferAttributes: destAttrs as CFDictionary,
            outputCallback: &callbackRecord,
            decompressionSessionOut: &created
        )
        guard status == noErr, let session = created else {
            log("VTDecompressionSessionCreate failed: \(status)")
            return false
        }

        VTSessionSetProperty(session, key: kVTDecompressionPropertyKey_RealTime, value: kCFBooleanTrue)
        decompressionSession = session
        formatDescription = fmtDesc
        activeSPS = sps
        activePPS = pps
        return true
    }

    fileprivate func handleDecodedBuffer(_ imageBuffer: CVImageBuffer?) {
        guard let imageBuffer = imageBuffer else { return }
        onDecodedFrame(imageBuffer)
    }
}

private let h264DecodeOutputCallback: VTDecompressionOutputCallback = { refcon, _, status, _, imageBuffer, _, _ in
    guard status == noErr, let refcon = refcon, let imageBuffer = imageBuffer else { return }
    let decoder = Unmanaged<H264Decoder>.fromOpaque(refcon).takeUnretainedValue()
    decoder.handleDecodedBuffer(imageBuffer)
}

private func splitAnnexBNalus(_ accessUnit: Data) -> [Data] {
    var nalus: [Data] = []
    let count = accessUnit.count
    guard count > 0 else { return nalus }

    accessUnit.withUnsafeBytes { rawBuf in
        guard let bytes = rawBuf.bindMemory(to: UInt8.self).baseAddress else { return }
        var i = 0
        var naluStart = -1
        while i < count {
            var startCodeLen = 0
            if i + 3 < count && bytes[i] == 0 && bytes[i + 1] == 0 && bytes[i + 2] == 0 && bytes[i + 3] == 1 {
                startCodeLen = 4
            } else if i + 2 < count && bytes[i] == 0 && bytes[i + 1] == 0 && bytes[i + 2] == 1 {
                startCodeLen = 3
            }

            if startCodeLen > 0 {
                if naluStart >= 0 && i > naluStart {
                    nalus.append(Data(bytes: bytes + naluStart, count: i - naluStart))
                }
                i += startCodeLen
                naluStart = i
            } else {
                i += 1
            }
        }

        if naluStart >= 0 && naluStart < count {
            nalus.append(Data(bytes: bytes + naluStart, count: count - naluStart))
        } else if naluStart < 0 {
            nalus.append(accessUnit)
        }
    }

    return nalus
}

private func readExactFromStdin(_ count: Int) -> (data: Data, eof: Bool, error: Bool) {
    var buffer = Data(count: count)
    var totalRead = 0
    let result: (eof: Bool, error: Bool) = buffer.withUnsafeMutableBytes { rawBuf in
        guard let base = rawBuf.baseAddress else { return (false, true) }
        while totalRead < count {
            let n = Darwin.read(STDIN_FILENO, base.advanced(by: totalRead), count - totalRead)
            if n > 0 {
                totalRead += n
            } else if n == 0 {
                return (true, false)
            } else {
                if errno == EINTR { continue }
                return (false, true)
            }
        }
        return (false, false)
    }
    if result.eof || result.error {
        return (Data(), result.eof, result.error)
    }
    return (buffer, false, false)
}

// MARK: - Self-test (synthetic VTCompression -> H264Decoder -> mmap ring)

private final class SelfTestEncoder {
    private var session: VTCompressionSession?
    private let onAccessUnit: (Data) -> Void

    init?(width: Int, height: Int, onAccessUnit: @escaping (Data) -> Void) {
        self.onAccessUnit = onAccessUnit
        var created: VTCompressionSession?
        let status = VTCompressionSessionCreate(
            allocator: nil,
            width: Int32(width),
            height: Int32(height),
            codecType: kCMVideoCodecType_H264,
            encoderSpecification: nil,
            imageBufferAttributes: nil,
            compressedDataAllocator: nil,
            outputCallback: selfTestOutputCallback,
            refcon: Unmanaged.passUnretained(self).toOpaque(),
            compressionSessionOut: &created
        )
        guard status == noErr, let vt = created else { return nil }
        VTSessionSetProperty(vt, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
        VTSessionSetProperty(vt, key: kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse)
        VTSessionSetProperty(vt, key: kVTCompressionPropertyKey_ProfileLevel, value: kVTProfileLevel_H264_Baseline_AutoLevel)
        VTCompressionSessionPrepareToEncodeFrames(vt)
        session = vt
    }

    func encode(pixelBuffer: CVPixelBuffer, pts: CMTime, duration: CMTime, forceKeyframe: Bool) {
        guard let vt = session else { return }
        var props: [CFString: Any]?
        if forceKeyframe {
            props = [kVTEncodeFrameOptionKey_ForceKeyFrame: kCFBooleanTrue!]
        }
        VTCompressionSessionEncodeFrame(
            vt,
            imageBuffer: pixelBuffer,
            presentationTimeStamp: pts,
            duration: duration,
            frameProperties: props as CFDictionary?,
            sourceFrameRefcon: nil,
            infoFlagsOut: nil
        )
    }

    func finish() {
        if let vt = session {
            VTCompressionSessionCompleteFrames(vt, untilPresentationTimeStamp: .invalid)
            VTCompressionSessionInvalidate(vt)
            session = nil
        }
    }

    fileprivate func handleEncoded(_ sampleBuffer: CMSampleBuffer) {
        guard CMSampleBufferDataIsReady(sampleBuffer) else { return }
        let startCode: [UInt8] = [0x00, 0x00, 0x00, 0x01]
        var au = Data()

        let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[CFString: Any]]
        let isKeyFrame = !(attachments?.first?[kCMSampleAttachmentKey_NotSync] as? Bool ?? false)
        if isKeyFrame, let fmt = CMSampleBufferGetFormatDescription(sampleBuffer) {
            var paramCount = 0
            CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
                fmt,
                parameterSetIndex: 0,
                parameterSetPointerOut: nil,
                parameterSetSizeOut: nil,
                parameterSetCountOut: &paramCount,
                nalUnitHeaderLengthOut: nil
            )
            for idx in 0..<paramCount {
                var ptr: UnsafePointer<UInt8>?
                var size = 0
                if CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
                    fmt,
                    parameterSetIndex: idx,
                    parameterSetPointerOut: &ptr,
                    parameterSetSizeOut: &size,
                    parameterSetCountOut: nil,
                    nalUnitHeaderLengthOut: nil
                ) == noErr, let ptr = ptr, size > 0 {
                    au.append(contentsOf: startCode)
                    au.append(ptr, count: size)
                }
            }
        }

        guard let block = CMSampleBufferGetDataBuffer(sampleBuffer) else { return }
        let totalLength = CMBlockBufferGetDataLength(block)
        guard totalLength > 0 else { return }
        var copy = Data(count: totalLength)
        let st = copy.withUnsafeMutableBytes { buf -> OSStatus in
            guard let base = buf.baseAddress else { return -1 }
            return CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: totalLength, destination: base)
        }
        guard st == kCMBlockBufferNoErr else { return }
        copy.withUnsafeBytes { buf in
            guard let bytes = buf.bindMemory(to: UInt8.self).baseAddress else { return }
            var offset = 0
            while offset + 4 <= totalLength {
                let naluLen = Int(bytes[offset]) << 24
                    | Int(bytes[offset + 1]) << 16
                    | Int(bytes[offset + 2]) << 8
                    | Int(bytes[offset + 3])
                offset += 4
                guard naluLen > 0, offset + naluLen <= totalLength else { break }
                au.append(contentsOf: startCode)
                au.append(bytes + offset, count: naluLen)
                offset += naluLen
            }
        }
        if !au.isEmpty {
            onAccessUnit(au)
        }
    }
}

private let selfTestOutputCallback: VTCompressionOutputCallback = { refcon, _, status, _, sampleBuffer in
    guard status == noErr, let refcon = refcon, let sampleBuffer = sampleBuffer else { return }
    let enc = Unmanaged<SelfTestEncoder>.fromOpaque(refcon).takeUnretainedValue()
    enc.handleEncoded(sampleBuffer)
}

private func runSelfTest() -> Int32 {
    let width = 640
    let height = 360
    let testRingPath = "\(ringDirPath)/bb-camera-selftest-\(getpid()).ring"
    defer { unlink(testRingPath) }

    guard let ring = CameraRingWriter(path: testRingPath) else {
        log("Self-test failed: could not open ring")
        return 1
    }

    var encodedAUs: [Data] = []
    guard let encoder = SelfTestEncoder(width: width, height: height, onAccessUnit: { au in
        encodedAUs.append(au)
    }) else {
        log("Self-test failed: could not create SelfTestEncoder")
        return 1
    }

    for idx in 0..<5 {
        var pb: CVPixelBuffer?
        let st = CVPixelBufferCreate(
            kCFAllocatorDefault,
            width,
            height,
            ringPixelFormat,
            nil,
            &pb
        )
        guard st == kCVReturnSuccess, let pixelBuffer = pb else {
            log("Self-test failed: CVPixelBufferCreate returned \(st)")
            return 1
        }
        CVPixelBufferLockBaseAddress(pixelBuffer, [])
        if let yPlane = CVPixelBufferGetBaseAddressOfPlane(pixelBuffer, 0) {
            let yBytes = CVPixelBufferGetBytesPerRowOfPlane(pixelBuffer, 0) * height
            memset(yPlane, Int32(32 + idx * 32), yBytes)
        }
        if let uvPlane = CVPixelBufferGetBaseAddressOfPlane(pixelBuffer, 1) {
            let uvBytes = CVPixelBufferGetBytesPerRowOfPlane(pixelBuffer, 1) * (height / 2)
            memset(uvPlane, 128, uvBytes)
        }
        CVPixelBufferUnlockBaseAddress(pixelBuffer, [])

        encoder.encode(
            pixelBuffer: pixelBuffer,
            pts: CMTime(value: CMTimeValue(idx), timescale: targetFPS),
            duration: CMTime(value: 1, timescale: targetFPS),
            forceKeyframe: idx == 0
        )
    }
    encoder.finish()

    guard encodedAUs.count == 5 else {
        log("Self-test failed: expected 5 encoded AUs, got \(encodedAUs.count)")
        return 1
    }

    var decodedCount = 0
    let decoder = H264Decoder { pb in
        decodedCount += 1
        ring.writeFrame(pixelBuffer: pb)
    }
    for au in encodedAUs {
        decoder.decodeAccessUnit(au)
    }
    decoder.invalidate()

    guard let snap = ring.readHeaderSnapshot() else {
        log("Self-test failed: could not read ring header")
        return 1
    }
    guard snap.magic == ringMagic,
          snap.version == ringVersion,
          snap.width == UInt32(width),
          snap.height == UInt32(height),
          snap.stride == UInt32(width),
          snap.format == ringPixelFormat,
          snap.slots == ringSlots,
          snap.slotBytes == UInt32(maxSlotBytes),
          snap.seq == 10,
          snap.tsNs > 0,
          decodedCount == 5 else {
        log("Self-test failed: header mismatch \(snap) decoded=\(decodedCount)")
        return 1
    }

    let lastSlot = Int(((snap.seq - 1) / 2) % UInt64(ringSlots))
    guard let slotData = ring.readSlotBytes(slotIndex: lastSlot, count: width * height),
          slotData.contains(where: { $0 != 0 }) else {
        log("Self-test failed: slot \(lastSlot) pixel bytes invalid")
        return 1
    }

    ring.clear()
    guard let cleared = ring.readHeaderSnapshot(), cleared.tsNs == 0, cleared.seq == 12 else {
        log("Self-test failed: clear() did not reset ts_ns and advance seq")
        return 1
    }

    let report = "{\"ok\":true,\"frames\":\(decodedCount),\"width\":\(snap.width),\"height\":\(snap.height),\"seq\":\(snap.seq)}\n"
    FileHandle.standardOutput.write(Data(report.utf8))
    return 0
}

// MARK: - Main

if CommandLine.arguments.contains("--self-test") {
    exit(runSelfTest())
}

if CommandLine.arguments.contains("--disable") {
    guard let ring = CameraRingWriter() else {
        exit(1)
    }
    ring.clear()
    exit(0)
}

guard let ring = CameraRingWriter() else {
    exit(1)
}

let decoder = H264Decoder { pixelBuffer in
    ring.writeFrame(pixelBuffer: pixelBuffer)
}

signal(SIGPIPE, SIG_IGN)
let sigQueue = DispatchQueue(label: "com.bluebubbles.camerabridge.signals")
signal(SIGTERM, SIG_IGN)
signal(SIGINT, SIG_IGN)
let termSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: sigQueue)
termSource.setEventHandler {
    decoder.invalidate()
    ring.clear(markClosed: true)
    exit(0)
}
termSource.resume()
let intSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: sigQueue)
intSource.setEventHandler {
    decoder.invalidate()
    ring.clear(markClosed: true)
    exit(0)
}
intSource.resume()

private func warnIfAllCamerasSuspended() {
    var deviceTypes: [AVCaptureDevice.DeviceType] = [.builtInWideAngleCamera]
    if #available(macOS 14.0, *) {
        deviceTypes.append(.external)
    } else {
        deviceTypes.append(.externalUnknown)
    }
    let session = AVCaptureDevice.DiscoverySession(deviceTypes: deviceTypes, mediaType: .video, position: .unspecified)
    let devices = session.devices
    if devices.isEmpty {
        log("Warning: no macOS video capture devices found; FaceTime camera uplink will be unavailable")
    } else if devices.allSatisfy({ $0.isSuspended }) {
        let names = devices.map { $0.localizedName }.joined(separator: ", ")
        log("Note: all macOS cameras are suspended (clamshell mode): [\(names)]; using BlueBubblesCameraHook synthetic pump")
    }
}

log("Starting FaceTime camera uplink bridge (ring=\(defaultRingPath))")
warnIfAllCamerasSuspended()

while true {
    let hdr = readExactFromStdin(4)
    if hdr.error {
        log("Stdin header read error: errno=\(errno)")
        decoder.invalidate()
        ring.clear(markClosed: true)
        exit(1)
    }
    if hdr.eof {
        decoder.invalidate()
        ring.clear(markClosed: true)
        exit(0)
    }

    let frameLen = hdr.data.withUnsafeBytes { raw -> UInt32 in
        let b = raw.bindMemory(to: UInt8.self)
        return (UInt32(b[0]) << 24) | (UInt32(b[1]) << 16) | (UInt32(b[2]) << 8) | UInt32(b[3])
    }

    if frameLen == 0 {
        ring.clear()
        continue
    }

    if frameLen > UInt32(maxInputFrameBytes) {
        log("Invalid frame length \(frameLen); resetting ring")
        decoder.invalidate()
        ring.clear(markClosed: true)
        exit(1)
    }

    let payload = readExactFromStdin(Int(frameLen))
    if payload.error {
        log("Stdin payload read error: errno=\(errno)")
        decoder.invalidate()
        ring.clear(markClosed: true)
        exit(1)
    }
    if payload.eof {
        decoder.invalidate()
        ring.clear(markClosed: true)
        exit(0)
    }

    decoder.decodeAccessUnit(payload.data)
}
