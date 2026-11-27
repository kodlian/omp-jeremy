import SwiftSyntax

/// Writes `@_dynamicReplacement` members whose bodies keep their original file and line numbers.
struct ThunkEmitter {
    /// Result builders that `body` gets implicitly from its protocol requirement, by `some` constraint.
    private static let implicitBuilders = [
        "View": "ViewBuilder", "SwiftUI.View": "ViewBuilder", "Scene": "SceneBuilder", "Commands": "CommandsBuilder",
        "ToolbarContent": "ToolbarContentBuilder", "TableColumnContent": "TableColumnBuilder",
        "TableRowContent": "TableRowBuilder",
    ]
    private static let keptModifiers: Set<String> = [
        "static", "class", "mutating", "nonmutating", "nonisolated", "final", "consuming", "borrowing", "__consuming",
    ]

    let converter: SourceLocationConverter
    let filePath: String

    func replacement(for decl: DeclSyntax) -> String {
        if let function = decl.as(FunctionDeclSyntax.self) {
            replacement(for: function)
        } else if let property = decl.as(VariableDeclSyntax.self) {
            replacement(for: property)
        } else {
            ""
        }
    }

    func located(_ node: Syntax) -> [String] {
        let line = converter.location(for: node.positionAfterSkippingLeadingTrivia).line
        return ["#sourceLocation(file: \(Self.literal(filePath)), line: \(line))", node.trimmedDescription, "#sourceLocation()"]
    }

    private func replacement(for node: FunctionDeclSyntax) -> String {
        let name = node.name.text
        let labels = node.signature.parameterClause.parameters.map { "\($0.firstName.text):" }.joined()
        let isBuilderWitness = (name == "body" && labels == "content:") || (name == "makeBody" && labels == "configuration:")
        let attributes = attributes(node.attributes, builderFor: isBuilderWitness ? node.signature.returnClause?.type : nil)
        let declaration = "private \(modifiers(node.modifiers))func __preview__\(name)"
            + (node.genericParameterClause?.trimmedDescription ?? "")
            + node.signature.trimmedDescription
            + (node.genericWhereClause.map { " \($0.trimmedDescription)" } ?? "")
        return (["@_dynamicReplacement(for: \(name)(\(labels)))"] + attributes + [declaration + " " + block(node.body?.statements)])
            .joined(separator: "\n")
    }

    private func replacement(for node: VariableDeclSyntax) -> String {
        guard let binding = node.bindings.first, let type = binding.typeAnnotation?.type,
              let accessorBlock = binding.accessorBlock
        else { return "" }
        let name = binding.pattern.trimmedDescription
        let attributes = attributes(node.attributes, builderFor: name == "body" ? type : nil)
        let accessors = switch accessorBlock.accessors {
        case .getter(let statements):
            block(statements)
        case .accessors(let list):
            "{\n" + list.map(accessor).joined(separator: "\n") + "\n}"
        }
        let declaration = "private \(modifiers(node.modifiers))var __preview__\(name): \(type.trimmedDescription) \(accessors)"
        return (["@_dynamicReplacement(for: \(name))"] + attributes + [declaration]).joined(separator: "\n")
    }

    private func accessor(_ node: AccessorDeclSyntax) -> String {
        let prefix = node.attributes.map(\.trimmedDescription) + node.modifiers.map(\.trimmedDescription)
        let specifier = node.accessorSpecifier.text + (node.parameters?.trimmedDescription ?? "")
            + (node.effectSpecifiers.map { " \($0.trimmedDescription)" } ?? "")
        return (prefix + [specifier]).joined(separator: " ") + " " + block(node.body?.statements)
    }

    private func block(_ statements: CodeBlockItemListSyntax?) -> String {
        guard let statements, let first = statements.first else { return "{\n}" }
        let line = converter.location(for: first.positionAfterSkippingLeadingTrivia).line
        return "{\n#sourceLocation(file: \(Self.literal(filePath)), line: \(line))\n"
            + statements.trimmedDescription + "\n#sourceLocation()\n}"
    }

    private func attributes(_ list: AttributeListSyntax, builderFor type: TypeSyntax?) -> [String] {
        var result = list.map(\.trimmedDescription)
        let hasBuilder = list.contains {
            $0.as(AttributeSyntax.self)?.attributeName.trimmedDescription.hasSuffix("Builder") == true
        }
        if !hasBuilder, let opaque = type?.as(SomeOrAnyTypeSyntax.self),
           opaque.someOrAnySpecifier.tokenKind == .keyword(.some),
           let builder = Self.implicitBuilders[opaque.constraint.trimmedDescription] {
            result.append("@\(builder)")
        }
        return result
    }

    private func modifiers(_ list: DeclModifierListSyntax) -> String {
        list.filter { Self.keptModifiers.contains($0.name.text) }.map { "\($0.trimmedDescription) " }.joined()
    }

    static func literal(_ text: String) -> String {
        var result = "\""
        for character in text {
            if character == "\\" || character == "\"" {
                result.append("\\")
            }
            result.append(character)
        }
        return result + "\""
    }
}
