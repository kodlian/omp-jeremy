/// A simulator from `simctl list devices`.
struct SimulatorDevice: Sendable, CustomStringConvertible {
    let udid: String
    let name: String
    let state: String
    /// Runtime identifier, such as `com.apple.CoreSimulator.SimRuntime.iOS-27-0`.
    let runtime: String

    var description: String {
        let parts = (runtime.split(separator: ".").last ?? "").split(separator: "-")
        guard let platform = parts.first else { return name }
        return "\(name) (\(platform) \(parts.dropFirst().joined(separator: ".")))"
    }
}
