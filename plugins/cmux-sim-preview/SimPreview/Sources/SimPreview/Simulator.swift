import Foundation

/// simctl operations on default-set simulators.
enum Simulator {
    static func waitUntilBooted(_ udid: String) async throws {
        try await Shell.run(["xcrun", "simctl", "bootstatus", udid, "-b"])
    }

    static func install(_ appPath: String, on udid: String) async throws {
        try await Shell.run(["xcrun", "simctl", "install", udid, appPath])
    }

    /// Whether the device already has this build: the installed copy of `codePath` has the same size and date.
    static func hasInstalled(_ codePath: String, bundleIdentifier: String, on udid: String) async -> Bool {
        guard let container = try? await Shell.run(["xcrun", "simctl", "get_app_container", udid, bundleIdentifier, "app"])
        else { return false }
        let installed = container.trimmingCharacters(in: .whitespacesAndNewlines) + "/" + URL(filePath: codePath).lastPathComponent
        guard let built = try? FileManager.default.attributesOfItem(atPath: codePath),
              let copy = try? FileManager.default.attributesOfItem(atPath: installed)
        else { return false }
        return built[.size] as? Int == copy[.size] as? Int
            && built[.modificationDate] as? Date == copy[.modificationDate] as? Date
    }

    /// Launches the app, replacing a running copy; `environment` reaches the app's process.
    static func launch(_ bundleIdentifier: String, on udid: String, environment: [String: String]) async throws {
        let childEnvironment = Dictionary(uniqueKeysWithValues: environment.map { ("SIMCTL_CHILD_\($0.key)", $0.value) })
        try await Shell.run(
            ["xcrun", "simctl", "launch", "--terminate-running-process", udid, bundleIdentifier],
            environment: childEnvironment
        )
    }

    static func terminate(_ bundleIdentifier: String, on udid: String) async {
        _ = try? await Shell.run(["xcrun", "simctl", "terminate", udid, bundleIdentifier])
    }

    static func isBooted(_ udid: String) async -> Bool {
        (try? await devices().first { $0.udid == udid }?.state) == "Booted"
    }

    static func screenshot(_ udid: String, to path: String) async throws {
        try await Shell.run(["xcrun", "simctl", "io", udid, "screenshot", path])
    }

    static func shutdown(_ udid: String) async {
        _ = try? await Shell.run(["xcrun", "simctl", "shutdown", udid])
    }

    static func name(of udid: String) async -> String {
        (try? await devices().first { $0.udid == udid }?.description) ?? udid
    }

    /// The device used last time, else an iPhone 17 Pro, else any iPhone. A booted device isn't preferred: it may be
    /// running someone's tests.
    static func defaultDevice(lastUsed: String?) async throws -> String {
        let iPhones = try await devices().filter { $0.name.hasPrefix("iPhone") }
        guard let device = iPhones.first(where: { $0.udid == lastUsed })
            ?? iPhones.first(where: { $0.name == "iPhone 17 Pro" }) ?? iPhones.first
        else { throw Shell.Failure(command: ["simctl"], status: 1, output: "No iPhone simulator is available.") }
        return device.udid
    }

    private static func devices() async throws -> [SimulatorDevice] {
        let output = try await Shell.run(["xcrun", "simctl", "list", "devices", "available", "-j"])
        let list = try JSONDecoder().decode(SimulatorDeviceList.self, from: Data(output.utf8))
        return list.devices.flatMap { runtime, devices in
            devices.map { SimulatorDevice(udid: $0.udid, name: $0.name, state: $0.state, runtime: runtime) }
        }
    }
}
