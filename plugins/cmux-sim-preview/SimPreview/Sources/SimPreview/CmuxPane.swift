import Foundation

/// A cmux Simulator pane, driven through the cmux CLI.
struct CmuxPane: Sendable {
    private static let executable = FileManager.default.isExecutableFile(atPath: bundledExecutable) ? bundledExecutable : "cmux"
    private static let bundledExecutable = "/Applications/cmux.app/Contents/Resources/bin/cmux"

    let surface: String

    /// The pane named by `surface`; else the caller workspace's first Simulator pane, or a new one to the right of the
    /// caller. Nil outside cmux.
    static func attach(surface: String?) async throws -> CmuxPane? {
        if let surface {
            return CmuxPane(surface: surface)
        }
        guard let workspace = ProcessInfo.processInfo.environment["CMUX_WORKSPACE_ID"] else { return nil }
        let list = try await Shell.run([executable, "ios", "list", "--workspace", workspace, "--json"])
        let panes = try JSONDecoder().decode(CmuxSimulatorList.self, from: Data(list.utf8))
        if let existing = panes.targets.first {
            return CmuxPane(surface: existing.surfaceRef)
        }
        let created = try await Shell.run([
            executable, "new-pane", "--type", "simulator", "--direction", "right", "--workspace", workspace,
            "--focus", "false",
        ])
        guard let surface = created.split(separator: " ").first(where: { $0.hasPrefix("surface:") }) else {
            throw Shell.Failure(command: ["cmux", "new-pane"], status: 1, output: created)
        }
        return CmuxPane(surface: String(surface))
    }

    /// The UDID of the simulator the pane shows, or nil when it shows none.
    func device() async -> String? {
        let output = try? await Shell.run([Self.executable, "ios", "context", "--udid", "--surface", surface])
        return output?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
    }

    func select(_ udid: String) async throws {
        try await Shell.run([Self.executable, "ios", "select", udid, "--surface", surface])
    }
}

private extension String {
    var nilIfEmpty: String? {
        isEmpty ? nil : self
    }
}
