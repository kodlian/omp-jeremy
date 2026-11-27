import AsyncAlgorithms
import Foundation
import ThunkKit

/// Keeps a #Preview running natively in the simulator a cmux pane shows. Follows the pane's device, takes stdin
/// commands and hot-reloads saved source files.
actor PreviewSession {
    private let options: Options
    private let project: XcodeProject
    private let link: LoaderLink
    private var loaderPath = ""
    private var products: BuildProducts?
    private var device: String?
    private var preview: String?
    private var previews: [String] = []
    /// Source text each file had when the app was last built; its layout decides whether an edit needs a rebuild.
    private var builtSources: [String: String] = [:]
    private var appliedSources: [String: String] = [:]
    /// Thunks loaded since the last build, replayed when the app relaunches on another device.
    private var thunks: [LoaderCommand] = []
    private var thunkCount = 0

    init(options: Options) throws {
        self.options = options
        project = XcodeProject(url: options.project, scheme: options.scheme)
        link = try LoaderLink()
        preview = options.preview
    }

    func run() async throws {
        try FileManager.default.createDirectory(at: project.cacheDirectory, withIntermediateDirectories: true)
        loaderPath = try await LoaderBuild.build(into: project.cacheDirectory)
        if let source = project.seedPackageCheckouts() {
            report("Cloned package checkouts from Xcode's \(source)")
        }
        if let products = project.unchangedProducts() {
            report("No changes since the last build")
            adopt(products)
        } else {
            try await build()
        }
        let pane = try await CmuxPane.attach(surface: options.surface)
        var initialDevice = options.device
        if initialDevice == nil, let pane {
            initialDevice = await pane.device()
        }
        let device: String
        if let initialDevice {
            device = initialDevice
        } else {
            let lastUsed = try? String(contentsOf: lastDeviceFile, encoding: .utf8)
            device = try await Simulator.defaultDevice(lastUsed: lastUsed)
        }
        let wasBooted = await Simulator.isBooted(device)
        if let pane, await pane.device() != device {
            try await pane.select(device)
        }
        if options.runsOnce {
            // Shown in a cmux pane, the preview stays up for the user to see; otherwise a booted device goes back down.
            await runOnce(on: device, shutsDownAfter: pane == nil && !wasBooted)
        }
        await launch(on: device)
        report("Commands: preview <name>, list, rebuild, quit")

        let (events, input) = AsyncStream.makeStream(of: SessionEvent.self)
        let link = link
        Task {
            for await event in link.events {
                input.yield(.loader(event))
            }
        }
        Task {
            let lines = FileHandle.standardInput.bytes.lines
            var iterator = lines.makeAsyncIterator()
            while let line = try? await iterator.next() {
                input.yield(.command(line))
            }
        }
        if let pane {
            Task {
                let selections = AsyncTimerSequence.repeating(every: .seconds(1))
                    .map { _ in await pane.device() }
                    .removeDuplicates()
                for await udid in selections {
                    input.yield(.deviceSelected(udid))
                }
            }
        }
        let projectDirectory = options.project.deletingLastPathComponent().path
        Task {
            for await paths in SourceWatcher.changes(under: projectDirectory) {
                input.yield(.sourcesChanged(paths))
            }
        }
        for await event in events {
            await handle(event)
        }
    }

    private func handle(_ event: SessionEvent) async {
        switch event {
        case .loader(let event):
            handleLoader(event)
        case .command(let line):
            await handleCommand(line)
        case .deviceSelected(let udid):
            if let udid, udid != device {
                await launch(on: udid)
            }
        case .sourcesChanged(let paths):
            await hotReload(paths)
        }
    }

    private func handleLoader(_ event: LoaderEvent) {
        switch event.event {
        case "ready":
            previews = event.previews ?? []
            report("Found \(previews.count) previews; `list` prints their names")
            if preview.map(previews.contains) != true, let first = previews.first {
                preview = first
                link.send(.show(first))
            }
            for thunk in thunks {
                link.send(thunk)
            }
        case "shown":
            report("Showing \(event.preview ?? "")")
        case "reloaded", "previews":
            previews = event.previews ?? previews
        case "error":
            report("App: \(event.message ?? "")")
        default:
            break
        }
    }

    private func handleCommand(_ line: String) async {
        let words = line.split(separator: " ", maxSplits: 1).map(String.init)
        switch words.first {
        case "preview" where words.count == 2:
            preview = words[1]
            link.send(.show(words[1]))
        case "list":
            report(previews.joined(separator: "\n"))
        case "rebuild":
            await rebuildAndRelaunch()
        case "quit":
            unlink(link.path)
            exit(0)
        case nil:
            break
        default:
            report("Commands: preview <name>, list, rebuild, quit")
        }
    }

    @discardableResult
    private func launch(on udid: String) async -> Bool {
        guard let products else { return false }
        if let device, device != udid {
            await Simulator.terminate(products.bundleIdentifier, on: device)
        }
        device = udid
        let name = await Simulator.name(of: udid)
        report("Launching on \(name)…")
        var environment = ["DYLD_INSERT_LIBRARIES": loaderPath, "SIM_PREVIEW_SOCKET": link.path]
        environment["SIM_PREVIEW_NAME"] = preview
        if products.hasDebugDylib {
            // The loader takes over from Xcode's stub executable, so the app's own startup never runs, like Xcode previews.
            environment["SIM_PREVIEW_HOST"] = "1"
        }
        do {
            try await Simulator.waitUntilBooted(udid)
            if await !Simulator.hasInstalled(products.codePath, bundleIdentifier: products.bundleIdentifier, on: udid) {
                try await Simulator.install(products.appPath, on: udid)
            }
            try await Simulator.launch(products.bundleIdentifier, on: udid, environment: environment)
            try? udid.write(to: lastDeviceFile, atomically: true, encoding: .utf8)
            return true
        } catch {
            report("Couldn't run the preview on \(name): \(error)")
            return false
        }
    }

    /// `--list` or `--screenshot`: launches, waits for the loader, does the one thing and exits; status 1 on failure.
    private func runOnce(on udid: String, shutsDownAfter: Bool) async -> Never {
        var result: String?
        var failure: String?
        if await launch(on: udid) {
            let link = link
            let timeout = Task {
                try await Task.sleep(for: .seconds(120))
                report("The app didn't report within 2 minutes")
                unlink(link.path)
                exit(1)
            }
            for await event in link.events {
                if event.event == "ready", options.list {
                    result = (event.previews ?? []).joined(separator: "\n")
                } else if event.event == "shown", let path = options.screenshot {
                    // Lets entrance animations and images settle before the capture.
                    try? await Task.sleep(for: .seconds(1.5))
                    do {
                        try await Simulator.screenshot(udid, to: path)
                        result = path
                    } catch {
                        failure = "\(error)"
                    }
                } else if event.event == "error" {
                    failure = (event.message ?? "") + ". `--list` prints the preview names."
                } else {
                    continue
                }
                break
            }
            timeout.cancel()
        } else {
            failure = "Couldn't launch the app."
        }
        if shutsDownAfter {
            await Simulator.shutdown(udid)
        }
        unlink(link.path)
        if let result {
            print(result)
            exit(0)
        }
        report(failure ?? "The app disconnected.")
        exit(1)
    }

    private func build() async throws {
        report("Building \(options.scheme)…")
        let start = ContinuousClock.now
        adopt(try await project.build())
        report("Built in \(Self.seconds(since: start))")
    }

    private func adopt(_ products: BuildProducts) {
        self.products = products
        thunks = []
        builtSources = [:]
        try? FileManager.default.removeItem(at: project.cacheDirectory.appending(path: "thunks"))
        for path in products.sourceFiles {
            builtSources[path] = try? String(contentsOfFile: path, encoding: .utf8)
        }
        appliedSources = builtSources
    }

    private func rebuildAndRelaunch() async {
        do {
            try await build()
            if let device {
                await launch(on: device)
            }
        } catch {
            report("\(error)")
        }
    }

    /// Swaps saved edits into the running app, or rebuilds when an edit goes beyond what a thunk can replace.
    private func hotReload(_ paths: Set<String>) async {
        guard let products else { return }
        var edits: [(path: String, text: String, command: SwiftCompileCommand)] = []
        for path in Set(paths.map(BuildProducts.canonical)).sorted() {
            guard let command = products.command(for: path),
                  let text = try? String(contentsOfFile: path, encoding: .utf8),
                  text != appliedSources[path]
            else { continue }
            edits.append((path, text, command))
        }
        if let reshaped = edits.first(where: { edit in
            builtSources[edit.path].map { LayoutSignature(source: $0) != LayoutSignature(source: edit.text) } ?? true
        }) {
            report("\(Self.fileName(reshaped.path)) changed more than function bodies; rebuilding…")
            return await rebuildAndRelaunch()
        }
        for edit in edits {
            let start = ContinuousClock.now
            do {
                let thunk = try await compileThunk(path: edit.path, text: edit.text, command: edit.command)
                appliedSources[edit.path] = edit.text
                thunks.append(thunk)
                link.send(thunk)
                report("Reloaded \(Self.fileName(edit.path)) in \(Self.seconds(since: start))")
            } catch let failure as Shell.Failure where failure.output.contains("could not be found") {
                report("\(Self.fileName(edit.path)) changed a declaration; rebuilding…")
                return await rebuildAndRelaunch()
            } catch let failure as Shell.Failure {
                let errors = failure.output.split(separator: "\n").filter { $0.contains(": error:") }.prefix(10)
                report("\(Self.fileName(edit.path)) doesn't compile:\n" + errors.joined(separator: "\n"))
            } catch {
                report("\(error)")
            }
        }
    }

    private func compileThunk(path: String, text: String, command: SwiftCompileCommand) async throws -> LoaderCommand {
        thunkCount += 1
        let file = Self.fileName(path)
        let stem = String(file.dropLast(".swift".count).map { $0.isLetter || $0.isNumber ? $0 : "_" })
        let module = command.moduleName ?? "App"
        let thunkModule = "\(module)_PreviewReplacement_\(stem)_\(thunkCount)"
        let directory = project.cacheDirectory.appending(path: "thunks/\(thunkCount)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let source = directory.appending(path: file)
        try ThunkGenerator.source(for: text, moduleName: module, filePath: path)
            .write(to: source, atomically: true, encoding: .utf8)
        let dylib = directory.appending(path: "\(thunkModule).dylib").path
        try await Shell.run(command.thunkInvocation(source: source.path, moduleName: thunkModule, output: dylib))
        return .reload(dylib: dylib, file: file)
    }

    /// Progress lines; in run-once mode they go to stderr, so stdout holds only the result.
    private func report(_ message: String) {
        let line = "\(Date.now.formatted(date: .omitted, time: .standard))  \(message)\n"
        if options.runsOnce {
            FileHandle.standardError.write(Data(line.utf8))
        } else {
            print(line, terminator: "")
        }
    }

    /// The simulator the last launch used, the default when neither a pane nor `--device` names one.
    private var lastDeviceFile: URL {
        project.cacheDirectory.appending(path: "device")
    }

    private static func fileName(_ path: String) -> String {
        URL(filePath: path).lastPathComponent
    }

    private static func seconds(since start: ContinuousClock.Instant) -> String {
        let elapsed = (ContinuousClock.now - start).components
        return String(format: "%.1fs", Double(elapsed.seconds) + Double(elapsed.attoseconds) / 1e18)
    }
}
