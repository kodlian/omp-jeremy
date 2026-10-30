import Darwin
import SwiftUI
import UIKit

// Injected with DYLD_INSERT_LIBRARIES into a Debug build of the app. Shows a #Preview in the app's window and takes
// commands from sim-preview over the Unix socket named by SIM_PREVIEW_SOCKET.

@_cdecl("sim_preview_loader_start")
public func simPreviewLoaderStart() {
    guard ProcessInfo.processInfo.environment["SIM_PREVIEW_HOST"] == nil else { return }
    NotificationCenter.default.addObserver(forName: UIWindow.didBecomeVisibleNotification, object: nil, queue: .main) { _ in
        DispatchQueue.main.async {
            MainActor.assumeIsolated { PreviewLoader.shared.start() }
        }
    }
}

/// Xcode's debug-dylib stub executable looks this symbol up in every loaded image and calls it from its `main`, before
/// the app's own entry point; Xcode previews use it to take over the process. With SIM_PREVIEW_HOST set it never
/// returns: the app's startup code never runs, and the process hosts the preview instead.
@_cdecl("__previews_injection_jit_link_entrypoint")
public func previewsInjectionEntryPoint(
    _ argc: Int32, _ argv: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>, _ link: UnsafeRawPointer?,
    _ callback: UnsafeRawPointer?
) {
    guard ProcessInfo.processInfo.environment["SIM_PREVIEW_HOST"] != nil else { return }
    _ = UIApplicationMain(argc, argv, nil, NSStringFromClass(PreviewHostDelegate.self))
}

@MainActor
final class PreviewLoader {
    static let shared = PreviewLoader()

    private var catalog = PreviewCatalog()
    private var link: HostLink?
    private var current: String?
    private var started = false

    func start() {
        guard !started else { return }
        started = true
        let bundlePath = Bundle.main.bundlePath
        catalog.scan { $0.hasPrefix(bundlePath) }
        let environment = ProcessInfo.processInfo.environment
        if let socketPath = environment["SIM_PREVIEW_SOCKET"] {
            link = HostLink(path: socketPath) { [weak self] message in
                self?.handle(message)
            }
        }
        send(["event": "ready", "previews": catalog.names])
        if let name = environment["SIM_PREVIEW_NAME"] {
            show(name)
        }
    }

    private func handle(_ message: [String: Any]) {
        switch message["command"] as? String {
        case "show":
            show(message["preview"] as? String ?? "")
        case "reload":
            reload(dylibPath: message["dylib"] as? String ?? "", file: message["file"] as? String ?? "")
        case "list":
            send(["event": "previews", "previews": catalog.names])
        default:
            send(["event": "error", "message": "unknown command \(message["command"] ?? "")"])
        }
    }

    private func show(_ name: String) {
        guard let view = catalog.view(named: name) else {
            return send(["event": "error", "message": "no preview named \(name)"])
        }
        let windows = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows)
        guard let window = windows.first(where: \.isKeyWindow) ?? windows.first else {
            return send(["event": "error", "message": "the app has no window"])
        }
        current = name
        window.rootViewController = UIHostingController(rootView: view)
        send(["event": "shown", "preview": name])
    }

    /// Loads a thunk dylib: its dynamic replacements apply on load, and its #Previews replace those of `file`.
    private func reload(dylibPath: String, file: String) {
        guard dlopen(dylibPath, RTLD_NOW) != nil else {
            return send(["event": "error", "message": String(cString: dlerror())])
        }
        let resolved = URL(fileURLWithPath: dylibPath).resolvingSymlinksInPath().path
        catalog.scan(file: file) { URL(fileURLWithPath: $0).resolvingSymlinksInPath().path == resolved }
        send(["event": "reloaded", "previews": catalog.names])
        if let current {
            show(current)
        }
    }

    private func send(_ message: [String: Any]) {
        if let link {
            link.send(message)
        } else {
            NSLog("sim-preview: %@", message.description)
        }
    }
}
