import Foundation

/// Command-line options.
struct Options: Sendable {
    struct UsageError: Error, CustomStringConvertible {
        var description: String {
            """
            usage: sim-preview <path to .xcodeproj or .xcworkspace> [--scheme <name>] [--preview <name>]
                               [--device <simulator UDID>] [--surface <cmux Simulator surface>]
                               [--list | --screenshot <path.png>]

              --list        print the app's preview names and exit
              --screenshot  show --preview, save a PNG of the simulator screen and exit
            """
        }
    }

    let project: URL
    let scheme: String
    let preview: String?
    let device: String?
    let surface: String?
    let list: Bool
    let screenshot: String?

    /// Whether to do one thing and exit instead of staying live.
    var runsOnce: Bool {
        list || screenshot != nil
    }

    init(arguments: [String]) throws(UsageError) {
        var values: [String: String] = [:]
        var positional: [String] = []
        var list = false
        var remaining = arguments[...]
        while let argument = remaining.popFirst() {
            if ["--scheme", "--preview", "--device", "--surface", "--screenshot"].contains(argument) {
                guard let value = remaining.popFirst() else { throw UsageError() }
                values[argument] = value
            } else if argument == "--list" {
                list = true
            } else if argument.hasPrefix("-") {
                throw UsageError()
            } else {
                positional.append(argument)
            }
        }
        guard positional.count == 1, !(list && values["--screenshot"] != nil),
              values["--screenshot"] == nil || values["--preview"] != nil
        else { throw UsageError() }
        project = URL(filePath: positional[0]).standardizedFileURL
        scheme = values["--scheme"] ?? project.deletingPathExtension().lastPathComponent
        preview = values["--preview"]
        device = values["--device"]
        surface = values["--surface"]
        self.list = list
        screenshot = values["--screenshot"].map { URL(filePath: $0).standardizedFileURL.path }
    }
}
