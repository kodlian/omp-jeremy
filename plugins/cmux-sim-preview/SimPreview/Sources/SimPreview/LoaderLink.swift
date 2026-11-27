import Darwin
import Foundation
import Synchronization

/// The Unix socket the injected loader connects to. Commands go to the latest connection, so a relaunched app takes
/// over from the one it replaced.
final class LoaderLink: Sendable {
    struct SocketError: Error, CustomStringConvertible {
        let path: String

        var description: String {
            "Couldn't listen on \(path): \(String(cString: strerror(errno)))"
        }
    }

    let path: String
    let events: AsyncStream<LoaderEvent>
    private let continuation: AsyncStream<LoaderEvent>.Continuation
    private let listener: Int32
    private let connection = Mutex<Int32>(-1)

    init() throws {
        Self.removeAbandonedSockets()
        let path = Self.path(for: getpid())
        unlink(path)
        let listener = socket(AF_UNIX, SOCK_STREAM, 0)
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: path.utf8) }
        let bound = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(listener, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard listener >= 0, bound == 0, listen(listener, 4) == 0 else { throw SocketError(path: path) }
        self.path = path
        self.listener = listener
        (events, continuation) = AsyncStream.makeStream()
        Thread { [self] in acceptConnections() }.start()
    }

    static func path(for pid: pid_t) -> String {
        "/tmp/sim-preview-\(pid).sock"
    }

    /// Deletes sockets of sim-preview processes that are gone; a killed process can't remove its own.
    private static func removeAbandonedSockets() {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: "/tmp")) ?? []
        for name in names where name.hasPrefix("sim-preview-") && name.hasSuffix(".sock") {
            let pid = pid_t(name.dropFirst("sim-preview-".count).dropLast(".sock".count)) ?? 0
            if pid > 0, kill(pid, 0) != 0, errno == ESRCH {
                unlink("/tmp/\(name)")
            }
        }
    }

    func send(_ command: LoaderCommand) {
        guard var data = try? JSONEncoder().encode(command) else { return }
        data.append(0x0A)
        connection.withLock { socket in
            guard socket >= 0 else { return }
            _ = data.withUnsafeBytes { write(socket, $0.baseAddress, $0.count) }
        }
    }

    private func acceptConnections() {
        while true {
            let socket = accept(listener, nil, nil)
            guard socket >= 0 else { continue }
            var noSignal: Int32 = 1
            setsockopt(socket, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, socklen_t(MemoryLayout<Int32>.size))
            let previous = connection.withLock { current in
                defer { current = socket }
                return current
            }
            if previous >= 0 {
                shutdown(previous, SHUT_RDWR)
            }
            Thread { [self] in readEvents(from: socket) }.start()
        }
    }

    private func readEvents(from socket: Int32) {
        var pending = Data()
        var buffer = [UInt8](repeating: 0, count: 65536)
        while true {
            let count = read(socket, &buffer, buffer.count)
            guard count > 0 else { break }
            pending.append(contentsOf: buffer[..<count])
            while let newline = pending.firstIndex(of: 0x0A) {
                if let event = try? JSONDecoder().decode(LoaderEvent.self, from: pending[pending.startIndex..<newline]) {
                    continuation.yield(event)
                }
                pending.removeSubrange(pending.startIndex...newline)
            }
        }
        connection.withLock { current in
            if current == socket {
                current = -1
            }
        }
        close(socket)
    }
}
