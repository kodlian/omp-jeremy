import Foundation

/// Compiles the dylib injected into the app (`SimPreview/Loader`) for the iOS simulator, when its sources changed.
enum LoaderBuild {
    private static let sources = URL(filePath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appending(path: "Loader")
    private static let target = "arm64-apple-ios17.0-simulator"

    static func build(into directory: URL) async throws -> String {
        let dylib = directory.appending(path: "SimPreviewLoader.dylib")
        let files = try FileManager.default.contentsOfDirectory(at: sources, includingPropertiesForKeys: [.contentModificationDateKey])
        // The folder's own date changes when a file is added or removed.
        if let built = modificationDate(of: dylib),
           ([sources] + files).allSatisfy({ modificationDate(of: $0).map { $0 < built } ?? false }) {
            return dylib.path
        }
        let object = directory.appending(path: "Constructor.o").path
        let swiftFiles = files.filter { $0.pathExtension == "swift" }.map(\.path)
        let xcrun = ["xcrun", "--sdk", "iphonesimulator"]
        try await Shell.run(xcrun + ["clang", "-target", target, "-c", sources.appending(path: "Constructor.c").path, "-o", object])
        try await Shell.run(
            xcrun + ["swiftc", "-target", target, "-emit-library", "-module-name", "SimPreviewLoader", "-o", dylib.path]
                + swiftFiles + [object]
        )
        return dylib.path
    }

    private static func modificationDate(of url: URL) -> Date? {
        try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate
    }
}
