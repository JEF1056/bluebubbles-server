import Foundation
import NaturalLanguage
#if canImport(Translation)
import Translation
#endif

struct Output: Encodable {
    let translatedText: String?
    let sourceLanguage: String?
    let targetLanguage: String?
    let error: String?
}

func writeJSON(_ out: Output, code: Int32) -> Never {
    if let data = try? JSONEncoder().encode(out),
       let json = String(data: data, encoding: .utf8) {
        print(json)
    } else {
        print("{\"error\":\"json_encode_failed\"}")
    }
    fflush(stdout)
    exit(code)
}

func fail(_ reason: String) -> Never {
    writeJSON(Output(translatedText: nil, sourceLanguage: nil, targetLanguage: nil, error: reason), code: 1)
}

var targetArg: String?
var sourceArg: String?
let args = Array(CommandLine.arguments.dropFirst())
var i = 0
while i < args.count {
    switch args[i] {
    case "--target":
        if i + 1 < args.count { targetArg = args[i + 1]; i += 1 }
    case "--source":
        if i + 1 < args.count { sourceArg = args[i + 1]; i += 1 }
    default:
        break
    }
    i += 1
}

guard let targetId = targetArg, !targetId.isEmpty else {
    fail("missing_target")
}

let inputData = FileHandle.standardInput.readDataToEndOfFile()
guard let text = String(data: inputData, encoding: .utf8),
      !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
    fail("empty_input")
}

let resolvedSourceId: String
if let src = sourceArg, !src.isEmpty, src.lowercased() != "auto" {
    resolvedSourceId = src
} else {
    let recognizer = NLLanguageRecognizer()
    recognizer.processString(text)
    guard let dominant = recognizer.dominantLanguage, dominant != .undetermined else {
        fail("unable_to_identify_language")
    }
    resolvedSourceId = dominant.rawValue
}

#if canImport(Translation)
if #available(macOS 26.0, *) {
    Task {
        let source = Locale.Language(identifier: resolvedSourceId)
        let target = Locale.Language(identifier: targetId)
        let availability = LanguageAvailability()
        let status = await availability.status(from: source, to: target)
        guard status == .installed else {
            fail(status == .unsupported ? "unsupported_language_pairing" : "language_pack_not_installed")
        }
        do {
            let session = TranslationSession(installedSource: source, target: target)
            let response = try await session.translate(text)
            writeJSON(
                Output(
                    translatedText: response.targetText,
                    sourceLanguage: response.sourceLanguage.minimalIdentifier,
                    targetLanguage: response.targetLanguage.minimalIdentifier,
                    error: nil
                ),
                code: 0
            )
        } catch {
            fail(error.localizedDescription)
        }
    }
    dispatchMain()
} else {
    fail("requires_macos_26")
}
#else
fail("translation_framework_unavailable")
#endif
