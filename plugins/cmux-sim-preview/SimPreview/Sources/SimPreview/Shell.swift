import Foundation

/// Runs command-line tools to completion.
enum Shell {
    struct Failure: Error, CustomStringConvertible {
        let command: [String]
        let status: Int32
        let output: String

        var description: String {
            "\(command.first ?? "command") exited with status \(status):\n\(output.suffix(4000))"
        }
    }

    /// Runs `arguments` through `/usr/bin/env` and returns stdout and stderr together; `environment` adds variables.
    @discardableResult
    static func run(_ arguments: [String], environment: [String: String] = [:]) async throws -> String {
        try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global().async {
                continuation.resume(with: Result { try runBlocking(arguments, environment: environment) })
            }
        }
    }

    private static func runBlocking(_ arguments: [String], environment: [String: String]) throws -> String {
        let process = Process()
        process.executableURL = URL(filePath: "/usr/bin/env")
        process.arguments = arguments
        if !environment.isEmpty {
            process.environment = ProcessInfo.processInfo.environment.merging(environment) { $1 }
        }
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        process.standardInput = FileHandle.nullDevice
        try process.run()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        let output = String(decoding: data, as: UTF8.self)
        guard process.terminationStatus == 0 else {
            throw Failure(command: arguments, status: process.terminationStatus, output: output)
        }
        return output
    }
}
