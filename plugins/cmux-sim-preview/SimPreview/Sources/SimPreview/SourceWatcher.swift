import CoreServices
import Foundation

/// Files changed under a directory, from FSEvents.
enum SourceWatcher {
    static func changes(under directory: String) -> AsyncStream<Set<String>> {
        AsyncStream { continuation in
            let sink = Unmanaged.passRetained(ChangeSink(continuation: continuation))
            var context = FSEventStreamContext(
                version: 0, info: sink.toOpaque(), retain: nil,
                release: { Unmanaged<ChangeSink>.fromOpaque($0!).release() }, copyDescription: nil
            )
            let callback: FSEventStreamCallback = { _, info, _, paths, _, _ in
                let sink = Unmanaged<ChangeSink>.fromOpaque(info!).takeUnretainedValue()
                let changed = unsafeBitCast(paths, to: NSArray.self) as? [String] ?? []
                sink.continuation.yield(Set(changed))
            }
            let flags = kFSEventStreamCreateFlagFileEvents | kFSEventStreamCreateFlagUseCFTypes | kFSEventStreamCreateFlagNoDefer
            guard let created = FSEventStreamCreate(
                nil, callback, &context, [directory] as CFArray, FSEventStreamEventId(kFSEventStreamEventIdSinceNow),
                0.15, FSEventStreamCreateFlags(flags)
            ) else {
                sink.release()
                return continuation.finish()
            }
            nonisolated(unsafe) let stream = created
            FSEventStreamSetDispatchQueue(stream, DispatchQueue(label: "sim-preview.source-watcher"))
            FSEventStreamStart(stream)
            continuation.onTermination = { _ in
                FSEventStreamStop(stream)
                FSEventStreamInvalidate(stream)
                FSEventStreamRelease(stream)
            }
        }
    }
}
