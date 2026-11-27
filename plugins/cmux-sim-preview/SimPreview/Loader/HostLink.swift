import Darwin
import Foundation

/// Newline-delimited JSON over a Unix socket to sim-preview; messages arrive on the main queue.
@MainActor
final class HostLink {
    private let socket: Int32
    private let source: any DispatchSourceRead
    private var pending: [UInt8] = []

    init?(path: String, onMessage: @escaping @MainActor ([String: Any]) -> Void) {
        let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        var address = sockaddr_un()
        guard fd >= 0, path.utf8.count < MemoryLayout.size(ofValue: address.sun_path) else { return nil }
        address.sun_family = sa_family_t(AF_UNIX)
        withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: path.utf8) }
        var noSignal: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, socklen_t(MemoryLayout<Int32>.size))
        let connected = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard connected == 0 else {
            close(fd)
            return nil
        }
        socket = fd
        source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: .main)
        source.setEventHandler { [weak self] in
            MainActor.assumeIsolated { self?.readAvailable(onMessage) }
        }
        source.setCancelHandler { close(fd) }
        source.resume()
    }

    func send(_ message: [String: Any]) {
        guard var data = try? JSONSerialization.data(withJSONObject: message) else { return }
        data.append(0x0A)
        data.withUnsafeBytes { buffer in
            var offset = 0
            while offset < buffer.count {
                let written = write(socket, buffer.baseAddress! + offset, buffer.count - offset)
                guard written > 0 else { return }
                offset += written
            }
        }
    }

    private func readAvailable(_ onMessage: @MainActor ([String: Any]) -> Void) {
        var buffer = [UInt8](repeating: 0, count: 65536)
        let count = read(socket, &buffer, buffer.count)
        guard count > 0 else { return source.cancel() }
        pending.append(contentsOf: buffer[..<count])
        while let newline = pending.firstIndex(of: 0x0A) {
            let line = Data(pending[..<newline])
            pending.removeSubrange(...newline)
            if let message = try? JSONSerialization.jsonObject(with: line) as? [String: Any] {
                onMessage(message)
            }
        }
    }
}
