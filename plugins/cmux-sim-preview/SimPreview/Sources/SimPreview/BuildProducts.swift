import Foundation

/// The built app and how each of its Swift modules was compiled.
struct BuildProducts: Sendable {
    let appPath: String
    let bundleIdentifier: String
    /// The app's code: the `.debug.dylib` Xcode splits Debug builds into, else the executable.
    let codePath: String
    private let commandsByFile: [String: SwiftCompileCommand]

    init(appPath: String, bundleIdentifier: String, commands: [String: SwiftCompileCommand]) {
        self.appPath = appPath
        self.bundleIdentifier = bundleIdentifier
        let executable = NSDictionary(contentsOfFile: "\(appPath)/Info.plist")?["CFBundleExecutable"] as? String
            ?? URL(filePath: appPath).deletingPathExtension().lastPathComponent
        let debugDylib = "\(appPath)/\(executable).debug.dylib"
        codePath = FileManager.default.fileExists(atPath: debugDylib) ? debugDylib : "\(appPath)/\(executable)"
        var commandsByFile: [String: SwiftCompileCommand] = [:]
        for command in commands.values {
            for file in command.sourceFiles {
                commandsByFile[Self.canonical(file)] = command
            }
        }
        self.commandsByFile = commandsByFile
    }

    /// Whether Xcode's stub executable fronts the code; it can then skip the app's own entry point.
    var hasDebugDylib: Bool {
        codePath.hasSuffix(".debug.dylib")
    }

    var sourceFiles: [String] {
        Array(commandsByFile.keys)
    }

    /// The compile of the module that contains `path`.
    func command(for path: String) -> SwiftCompileCommand? {
        commandsByFile[Self.canonical(path)]
    }

    static func canonical(_ path: String) -> String {
        URL(filePath: path).resolvingSymlinksInPath().path
    }
}
