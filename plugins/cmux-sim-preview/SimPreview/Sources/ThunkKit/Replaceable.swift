import SwiftSyntax

/// Which declarations a thunk swaps in with `@_dynamicReplacement`: functions and computed properties with bodies.
enum Replaceable {
    private static let blockingAttributes: Set<String> = [
        "objc", "nonobjc", "IBAction", "IBSegueAction", "_cdecl", "_silgen_name", "inlinable", "_transparent",
        "_alwaysEmitIntoClient", "_dynamicReplacement", "backDeployed",
    ]

    static func function(_ node: FunctionDeclSyntax) -> Bool {
        guard node.body != nil, case .identifier = node.name.tokenKind else { return false }
        return !hasBlockingAttribute(node.attributes)
    }

    static func property(_ node: VariableDeclSyntax) -> Bool {
        guard node.bindingSpecifier.tokenKind == .keyword(.var),
              node.bindings.count == 1,
              let binding = node.bindings.first,
              binding.pattern.is(IdentifierPatternSyntax.self),
              binding.typeAnnotation != nil,
              binding.initializer == nil,
              let accessorBlock = binding.accessorBlock,
              !node.modifiers.contains(where: { $0.name.tokenKind == .keyword(.lazy) }),
              !hasBlockingAttribute(node.attributes)
        else { return false }
        switch accessorBlock.accessors {
        case .getter:
            return true
        case .accessors(let accessors):
            return accessors.allSatisfy {
                [.keyword(.get), .keyword(.set)].contains($0.accessorSpecifier.tokenKind) && $0.body != nil
            }
        }
    }

    private static func hasBlockingAttribute(_ attributes: AttributeListSyntax) -> Bool {
        attributes.contains {
            guard let attribute = $0.as(AttributeSyntax.self) else { return true }
            return blockingAttributes.contains(attribute.attributeName.trimmedDescription)
        }
    }
}
