import CryptoKit
import Foundation

/// Builds a scheme's app for the iOS simulator with dynamic replacement enabled, into a private DerivedData.
struct XcodeProject: Sendable {
    struct BuildFailure: Error, CustomStringConvertible {
        let log: String

        var description: String {
            let errors = log.split(separator: "\n").filter { $0.contains(": error:") }
            return "Build failed:\n" + (errors.isEmpty ? log.split(separator: "\n").suffix(30) : errors.prefix(20))
                .joined(separator: "\n")
        }
    }

    private static let replacementFlags =
        "OTHER_SWIFT_FLAGS=$(inherited) -Xfrontend -enable-implicit-dynamic -Xfrontend -enable-private-imports "
        + "-Xfrontend -enable-dynamic-replacement-chaining"

    /// `env -i` arguments giving xcodebuild the same environment, in the same order, on every run and in every
    /// terminal: the build system folds environment changes (cmux puts a per-terminal directory on PATH) into its
    /// task signatures and recompiles every module.
    private static let environment: [String] = {
        let kept = ["HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "DEVELOPER_DIR", "SSH_AUTH_SOCK"]
        var values = ProcessInfo.processInfo.environment.filter { kept.contains($0.key) }
        values["PATH"] = "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin"
        return ["-i"] + values.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }
    }()

    let url: URL
    let scheme: String
    let cacheDirectory: URL

    init(url: URL, scheme: String) {
        self.url = url
        self.scheme = scheme
        let digest = SHA256.hash(data: Data(url.path.utf8)).prefix(6).map { String(format: "%02x", $0) }.joined()
        cacheDirectory = URL.cachesDirectory
            .appending(path: "sim-preview/\(url.deletingPathExtension().lastPathComponent)-\(digest)")
    }

    private var commandsFile: URL {
        cacheDirectory.appending(path: "compile-commands.json")
    }

    private var applicationFile: URL {
        cacheDirectory.appending(path: "application.json")
    }

    private var stampFile: URL {
        cacheDirectory.appending(path: "last-build")
    }

    private var derivedData: URL {
        cacheDirectory.appending(path: "DerivedData")
    }

    private var xcodebuild: [String] {
        Self.environment + [
            "xcodebuild", url.pathExtension == "xcworkspace" ? "-workspace" : "-project", url.path,
            "-scheme", scheme, "-configuration", "Debug", "-destination", "generic/platform=iOS Simulator",
            "-derivedDataPath", derivedData.path,
        ]
    }

    /// Clones (copy-on-write, one `clonefile` call per folder) the freshest package checkouts Xcode keeps for a project
    /// of the same name, so the first build doesn't download them again. The bare git clones in `repositories` (6.6 GB
    /// for a large app) only serve package resolution, which the pinned checkouts make unnecessary, so they stay behind.
    /// Returns the DerivedData folder it cloned from.
    func seedPackageCheckouts() -> String? {
        let destination = derivedData.appending(path: "SourcePackages")
        let name = url.deletingPathExtension().lastPathComponent
        let xcodeDerivedData = URL.homeDirectory.appending(path: "Library/Developer/Xcode/DerivedData")
        guard !FileManager.default.fileExists(atPath: destination.path),
              let folders = try? FileManager.default.contentsOfDirectory(at: xcodeDerivedData, includingPropertiesForKeys: nil)
        else { return nil }
        let resolved = folders.filter { $0.lastPathComponent.hasPrefix("\(name)-") }.compactMap { folder in
            let state = folder.appending(path: "SourcePackages/workspace-state.json")
            return (try? state.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate)
                .map { (folder, $0) }
        }
        guard let source = resolved.max(by: { $0.1 < $1.1 })?.0,
              (try? FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)) != nil
        else { return nil }
        let sourcePackages = source.appending(path: "SourcePackages")
        for folder in ["checkouts", "artifacts", "prebuilts"]
        where FileManager.default.fileExists(atPath: sourcePackages.appending(path: folder).path) {
            guard clonefile(sourcePackages.appending(path: folder).path, destination.appending(path: folder).path, 0) == 0 else {
                try? FileManager.default.removeItem(at: destination)
                return nil
            }
        }
        // The package state holds absolute paths to binary artifacts; point them at the clone, since Xcode may delete
        // the original DerivedData.
        guard let text = try? String(contentsOf: sourcePackages.appending(path: "workspace-state.json"), encoding: .utf8),
              (try? text.replacingOccurrences(of: sourcePackages.path, with: destination.path)
                  .write(to: destination.appending(path: "workspace-state.json"), atomically: true, encoding: .utf8)) != nil
        else {
            try? FileManager.default.removeItem(at: destination)
            return nil
        }
        return source.lastPathComponent
    }

    /// The last build's products, when no file under the project's directory changed since that build started.
    /// A no-op xcodebuild of a large app still takes 15 seconds.
    func unchangedProducts() -> BuildProducts? {
        guard let application = try? JSONDecoder().decode(ApplicationProduct.self, from: Data(contentsOf: applicationFile)),
              let commands = try? JSONDecoder().decode([String: SwiftCompileCommand].self, from: Data(contentsOf: commandsFile)),
              let built = try? stampFile.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate,
              FileManager.default.fileExists(atPath: application.path),
              let files = FileManager.default.enumerator(
                  at: url.deletingLastPathComponent(), includingPropertiesForKeys: [.contentModificationDateKey],
                  options: .skipsHiddenFiles
              )
        else { return nil }
        for case let file as URL in files {
            if ["xcuserdata", "DerivedData"].contains(file.lastPathComponent) {
                files.skipDescendants()
            } else if let modified = try? file.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate,
                      modified > built {
                return nil
            }
        }
        return BuildProducts(appPath: application.path, bundleIdentifier: application.bundleIdentifier, commands: commands)
    }

    func build() async throws -> BuildProducts {
        let application = try await applicationProduct()
        let logFile = cacheDirectory.appending(path: "build.log")
        let started = Date.now
        try? FileManager.default.removeItem(at: stampFile)
        let log: String
        do {
            log = try await Shell.run(
                xcodebuild + ["ARCHS=arm64", "COMPILER_INDEX_STORE_ENABLE=NO", Self.replacementFlags, "build"]
            )
        } catch let failure as Shell.Failure {
            try? failure.output.write(to: logFile, atomically: true, encoding: .utf8)
            throw BuildFailure(log: failure.output)
        }
        try? log.write(to: logFile, atomically: true, encoding: .utf8)
        // A no-op build logs no compiles, so keep the commands of earlier builds.
        var commands = (try? JSONDecoder().decode([String: SwiftCompileCommand].self, from: Data(contentsOf: commandsFile))) ?? [:]
        commands.merge(SwiftCompileCommand.all(inBuildLog: log)) { $1 }
        try JSONEncoder().encode(commands).write(to: commandsFile)
        // Stamped with the start time, so files saved during the build count as changed.
        FileManager.default.createFile(atPath: stampFile.path, contents: nil, attributes: [.modificationDate: started])
        return BuildProducts(appPath: application.path, bundleIdentifier: application.bundleIdentifier, commands: commands)
    }

    /// The scheme's app, from `-showBuildSettings` on the first build and cached after, since that call takes seconds.
    private func applicationProduct() async throws -> ApplicationProduct {
        if let cached = try? JSONDecoder().decode(ApplicationProduct.self, from: Data(contentsOf: applicationFile)) {
            return cached
        }
        let output = try await Shell.run(xcodebuild + ["-showBuildSettings", "-json"])
        let targets = try JSONDecoder().decode([TargetSettings].self, from: Data(output.drop { $0 != "[" }.utf8))
        guard let settings = targets.first(where: { $0.buildSettings["WRAPPER_EXTENSION"] == "app" })?.buildSettings,
              let bundleIdentifier = settings["PRODUCT_BUNDLE_IDENTIFIER"], let directory = settings["TARGET_BUILD_DIR"],
              let wrapper = settings["WRAPPER_NAME"]
        else { throw BuildFailure(log: "Scheme \(scheme) builds no iOS app.") }
        let product = ApplicationProduct(path: "\(directory)/\(wrapper)", bundleIdentifier: bundleIdentifier)
        try JSONEncoder().encode(product).write(to: applicationFile)
        return product
    }
}
