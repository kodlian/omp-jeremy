import Foundation

/// One module's swiftc driver invocation, taken from the xcodebuild log.
struct SwiftCompileCommand: Codable, Sendable {
    private static let droppedWithValue: Set<String> = [
        "-output-file-map", "-index-store-path", "-emit-module-path", "-emit-objc-header-path",
        "-emit-localized-strings-path", "-const-gather-protocols-list", "-dependency-scan-serialize-diagnostics-path",
        "-module-name", "-clang-scanner-module-cache-path", "-sdk-module-cache-path", "-module-cache-path",
        "-emit-module-interface-path", "-emit-private-module-interface-path", "-emit-module-source-info-path",
        "-serialize-diagnostics-path", "-emit-dependencies-path", "-pch-output-dir",
    ]
    private static let dropped: Set<String> = [
        "-c", "-enable-batch-mode", "-incremental", "-save-temps", "-emit-dependencies", "-emit-module",
        "-serialize-diagnostics", "-emit-objc-header", "-emit-const-values", "-emit-localized-strings",
        "-experimental-emit-module-separately", "-explicit-module-build", "-validate-clang-modules-once", "-disable-cmo",
        "-parseable-output", "-use-frontend-parseable-output", "-emit-module-interface",
    ]

    let arguments: [String]

    var moduleName: String? {
        value(after: "-module-name")
    }

    /// Source files compiled into the module, read from its `@…SwiftFileList` argument.
    var sourceFiles: [String] {
        guard let list = arguments.first(where: { $0.hasPrefix("@") }),
              let contents = try? String(contentsOfFile: String(list.dropFirst()), encoding: .utf8)
        else { return [] }
        return contents.split(separator: "\n").map(String.init)
    }

    /// Every arm64 module compile in an xcodebuild log, by module name.
    static func all(inBuildLog log: String) -> [String: SwiftCompileCommand] {
        var commands: [String: SwiftCompileCommand] = [:]
        for line in log.split(separator: "\n") {
            guard let marker = line.range(of: "builtin-SwiftDriver -- ") else { continue }
            let command = SwiftCompileCommand(arguments: ShellWords.split(line[marker.upperBound...]))
            guard command.value(after: "-target")?.hasPrefix("arm64-") == true, let module = command.moduleName else {
                continue
            }
            commands[module] = command
        }
        return commands
    }

    /// This module's compile reshaped to build `source` into a dylib whose replacements patch the module in place.
    func thunkInvocation(source: String, moduleName thunkModule: String, output: String) -> [String] {
        var kept: [String] = []
        var moduleCachePath: String?
        var moduleDirectory: String?
        var index = 1
        while index < arguments.count {
            let argument = arguments[index]
            index += 1
            if Self.droppedWithValue.contains(argument), index < arguments.count {
                let value = arguments[index]
                index += 1
                if argument == "-emit-module-path" {
                    moduleDirectory = URL(filePath: value).deletingLastPathComponent().path
                } else if argument == "-module-cache-path", moduleCachePath == nil {
                    moduleCachePath = value
                }
            } else if !Self.dropped.contains(argument), !argument.hasPrefix("@"), !Self.isJobCount(argument) {
                kept.append(argument)
            }
        }
        return [arguments[0]] + kept
            + (moduleCachePath.map { ["-module-cache-path", $0] } ?? [])
            + (moduleDirectory.map { ["-I", $0] } ?? [])
            + [
                "-module-name", thunkModule, "-emit-library", "-parse-as-library", "-suppress-warnings",
                "-Xfrontend", "-disable-previous-implementation-calls-in-dynamic-replacements",
                "-Xlinker", "-undefined", "-Xlinker", "suppress", "-Xlinker", "-flat_namespace",
                "-o", output, source,
            ]
    }

    private func value(after flag: String) -> String? {
        guard let index = arguments.firstIndex(of: flag), index + 1 < arguments.count else { return nil }
        return arguments[index + 1]
    }

    private static func isJobCount(_ argument: String) -> Bool {
        argument.hasPrefix("-j") && argument.count > 2 && argument.dropFirst(2).allSatisfy(\.isNumber)
    }
}
