import SwiftParser
import SwiftSyntax

/// Builds a thunk: Swift source that swaps one file's member bodies and #Preview macros into a running app built
/// with `-enable-implicit-dynamic` and `-enable-private-imports`.
public enum ThunkGenerator {
    public static func source(for text: String, moduleName: String, filePath: String) -> String {
        let file = Parser.parse(source: text)
        let structure = SourceStructure(file)
        let emitter = ThunkEmitter(converter: SourceLocationConverter(fileName: filePath, tree: file), filePath: filePath)
        let fileName = filePath.split(separator: "/").last.map(String.init) ?? filePath
        var lines: [String] = []
        for (item, conditions) in structure.entries {
            if case .import(let node) = item, node.path.first?.name.text != moduleName {
                lines += wrapped([node.trimmedDescription], in: conditions)
            }
        }
        lines.append("@_private(sourceFile: \(ThunkEmitter.literal(fileName))) import \(moduleName)")
        for (item, conditions) in structure.entries {
            switch item {
            case .import:
                continue
            case .member(let decl, let type, let whereClause):
                let member = emitter.replacement(for: decl)
                if let type {
                    let header = "extension \(type)\(whereClause.map { " \($0)" } ?? "") {"
                    lines += wrapped([header, member, "}"], in: conditions)
                } else {
                    lines += wrapped([member], in: conditions)
                }
            case .preview(let node):
                lines += wrapped(emitter.located(node), in: conditions)
            }
        }
        return lines.joined(separator: "\n") + "\n"
    }

    private static func wrapped(_ lines: [String], in conditions: [String]) -> [String] {
        conditions.isEmpty ? lines : ["#if \(conditions.joined(separator: " && "))"] + lines + ["#endif"]
    }
}
