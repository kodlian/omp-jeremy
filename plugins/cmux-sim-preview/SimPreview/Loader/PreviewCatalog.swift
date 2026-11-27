import DeveloperToolsSupport
import MachO
import SwiftUI

/// #Preview registrations found in loaded images, keyed by display name, or `File.swift#index` when unnamed.
@MainActor
struct PreviewCatalog {
    private typealias Accessor = @convention(c) (Int) -> UnsafeRawPointer?

    private(set) var names: [String] = []
    private var registries: [String: (file: String, type: any PreviewRegistry.Type)] = [:]
    private var scannedImages: Set<UInt> = []

    /// Scans images not seen before whose path passes `include`. Previews found replace earlier ones with the same
    /// key; `file` stands in for the registry's own file name, for thunk images.
    mutating func scan(file: String? = nil, include: (String) -> Bool) {
        var found: [(file: String, line: Int, name: String?, type: any PreviewRegistry.Type)] = []
        for image in 0..<_dyld_image_count() {
            guard let header = _dyld_get_image_header(image), let imageName = _dyld_get_image_name(image) else {
                continue
            }
            let address = UInt(bitPattern: header)
            guard !scannedImages.contains(address), include(String(cString: imageName)) else { continue }
            scannedImages.insert(address)
            for type in Self.registryTypes(in: header) {
                guard let preview = try? type.makePreview() else { continue }
                let name = Self.child(preview, "displayName").flatMap { $0 as? String }
                found.append((file ?? (type.fileID as NSString).lastPathComponent, type.line, name, type))
            }
        }
        for (file, entries) in Dictionary(grouping: found, by: \.file).sorted(by: { $0.key < $1.key }) {
            for (index, entry) in entries.sorted(by: { $0.line < $1.line }).enumerated() {
                var key = entry.name ?? "\(file)#\(index)"
                if let existing = registries[key], existing.file != file {
                    key = "\(key) (\(file))"
                }
                if registries[key] == nil {
                    names.append(key)
                }
                registries[key] = (file, entry.type)
            }
        }
    }

    func view(named name: String) -> AnyView? {
        guard let registry = registries[name]?.type, let preview = try? registry.makePreview() else { return nil }
        return Self.view(of: preview)
    }

    /// Calls the body closure stored at Preview.dataSource.preview.structure.singlePreview.makeBody.
    private static func view(of preview: Preview) -> AnyView? {
        guard let source = child(preview, "dataSource").flatMap({ child($0, "preview") }),
              let single = child(source, "structure").flatMap({ child($0, "singlePreview") }),
              let makeBody = Mirror(reflecting: single).children.first?.value,
              let accessor = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "$s7SwiftUI15ViewPreviewBodyVMa"),
              let metadata = unsafeBitCast(accessor, to: Accessor.self)(0)
        else { return nil }
        func call<Body>(_: Body.Type) -> Any? {
            if let body = makeBody as? @MainActor () -> Body {
                return body()
            }
            return (makeBody as? () -> Body).map { $0() }
        }
        guard let body = _openExistential(unsafeBitCast(metadata, to: Any.Type.self), do: call) else { return nil }
        if let view = body as? any View {
            return AnyView(view)
        }
        return child(body, "body").flatMap { $0 as? any View }.map { AnyView($0) }
    }

    private static func child(_ value: Any, _ label: String) -> Any? {
        Mirror(reflecting: value).children.first { $0.label == label }?.value
    }

    /// Types the #Preview macro generated in one image, found through its Swift conformance records.
    private static func registryTypes(in header: UnsafePointer<mach_header>) -> [any PreviewRegistry.Type] {
        var size: UInt = 0
        let header64 = UnsafeRawPointer(header).assumingMemoryBound(to: mach_header_64.self)
        guard let section = getsectiondata(header64, "__TEXT", "__swift5_proto", &size) else { return [] }
        var types: [any PreviewRegistry.Type] = []
        for offset in stride(from: 0, to: Int(size), by: 4) {
            guard let conformance = relative(UnsafeRawPointer(section) + offset) else { continue }
            // Protocol: relative pointer whose low bit marks an indirect reference into another image. Indirect
            // references to weakly linked images that aren't loaded are null.
            let protocolOffset = conformance.load(as: Int32.self)
            var target: UnsafeRawPointer? = conformance + Int(protocolOffset & ~1)
            if protocolOffset & 1 != 0 {
                target = target?.load(as: UnsafeRawPointer?.self)
            }
            // Protocol descriptor: flags, parent, then a relative pointer to the name.
            guard let target, let name = relative(target + 8),
                  strcmp(name.assumingMemoryBound(to: CChar.self), "PreviewRegistry") == 0
            else { continue }
            // Type reference kind lives in bits 3...5 of the flags at offset 12; 0 is a direct type descriptor.
            let flags = (conformance + 12).load(as: UInt32.self)
            guard (flags >> 3) & 0x7 == 0,
                  let descriptor = relative(conformance + 4),
                  let accessorAddress = relative(descriptor + 12),
                  let metadata = unsafeBitCast(accessorAddress, to: Accessor.self)(0),
                  let type = unsafeBitCast(metadata, to: Any.Type.self) as? any PreviewRegistry.Type
            else { continue }
            types.append(type)
        }
        return types
    }

    private static func relative(_ field: UnsafeRawPointer) -> UnsafeRawPointer? {
        let offset = field.load(as: Int32.self)
        return offset == 0 ? nil : field + Int(offset)
    }
}
