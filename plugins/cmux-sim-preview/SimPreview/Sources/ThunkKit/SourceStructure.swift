import SwiftSyntax

/// The parts of a source file a thunk carries: imports, replaceable members and #Preview macros, each with the
/// `#if` conditions it sits under.
struct SourceStructure {
    enum Item {
        case `import`(ImportDeclSyntax)
        case member(DeclSyntax, type: String?, whereClause: String?)
        case preview(Syntax)
    }

    private(set) var entries: [(item: Item, conditions: [String])] = []

    init(_ file: SourceFileSyntax) {
        walk(file.statements, conditions: [])
    }

    /// Source a thunk carries: imports, member bodies and #Preview macros. Anything else needs a rebuild to change.
    var thunkedRanges: [Range<AbsolutePosition>] {
        entries.compactMap { entry in
            switch entry.item {
            case .import(let node):
                node.range
            case .member(let decl, _, _):
                decl.as(FunctionDeclSyntax.self)?.body?.range
                    ?? decl.as(VariableDeclSyntax.self)?.bindings.first?.accessorBlock?.range
            case .preview(let node):
                node.range
            }
        }
    }

    private mutating func walk(_ statements: CodeBlockItemListSyntax, conditions: [String]) {
        for statement in statements {
            switch statement.item {
            case .decl(let decl):
                walk(decl, conditions: conditions)
            case .expr(let expression):
                if let macro = expression.as(MacroExpansionExprSyntax.self), macro.macroName.text == "Preview" {
                    entries.append((.preview(Syntax(macro)), conditions))
                }
            case .stmt:
                break
            }
        }
    }

    private mutating func walk(_ decl: DeclSyntax, conditions: [String]) {
        switch decl.as(DeclSyntaxEnum.self) {
        case .importDecl(let node):
            entries.append((.import(node), conditions))
        case .structDecl(let node):
            walkMembers(node.memberBlock.members, type: node.name.text, whereClause: nil, conditions: conditions)
        case .classDecl(let node):
            walkMembers(node.memberBlock.members, type: node.name.text, whereClause: nil, conditions: conditions)
        case .enumDecl(let node):
            walkMembers(node.memberBlock.members, type: node.name.text, whereClause: nil, conditions: conditions)
        case .actorDecl(let node):
            walkMembers(node.memberBlock.members, type: node.name.text, whereClause: nil, conditions: conditions)
        case .extensionDecl(let node):
            walkMembers(
                node.memberBlock.members,
                type: node.extendedType.trimmedDescription,
                whereClause: node.genericWhereClause?.trimmedDescription,
                conditions: conditions
            )
        case .functionDecl(let node) where Replaceable.function(node):
            entries.append((.member(decl, type: nil, whereClause: nil), conditions))
        case .variableDecl(let node) where Replaceable.property(node):
            entries.append((.member(decl, type: nil, whereClause: nil), conditions))
        case .macroExpansionDecl(let node) where node.macroName.text == "Preview":
            entries.append((.preview(Syntax(node)), conditions))
        case .ifConfigDecl(let node):
            for (clause, clauseConditions) in Self.clauses(of: node, inside: conditions) {
                if case .statements(let statements) = clause.elements {
                    walk(statements, conditions: clauseConditions)
                }
            }
        default:
            break
        }
    }

    private mutating func walkMembers(
        _ members: MemberBlockItemListSyntax, type: String, whereClause: String?, conditions: [String]
    ) {
        for member in members {
            let decl = member.decl
            switch decl.as(DeclSyntaxEnum.self) {
            case .functionDecl(let node) where Replaceable.function(node):
                entries.append((.member(decl, type: type, whereClause: whereClause), conditions))
            case .variableDecl(let node) where Replaceable.property(node):
                entries.append((.member(decl, type: type, whereClause: whereClause), conditions))
            case .structDecl(let node):
                walkMembers(node.memberBlock.members, type: "\(type).\(node.name.text)", whereClause: nil, conditions: conditions)
            case .classDecl(let node):
                walkMembers(node.memberBlock.members, type: "\(type).\(node.name.text)", whereClause: nil, conditions: conditions)
            case .enumDecl(let node):
                walkMembers(node.memberBlock.members, type: "\(type).\(node.name.text)", whereClause: nil, conditions: conditions)
            case .actorDecl(let node):
                walkMembers(node.memberBlock.members, type: "\(type).\(node.name.text)", whereClause: nil, conditions: conditions)
            case .ifConfigDecl(let node):
                for (clause, clauseConditions) in Self.clauses(of: node, inside: conditions) {
                    if case .decls(let nested) = clause.elements {
                        walkMembers(nested, type: type, whereClause: whereClause, conditions: clauseConditions)
                    }
                }
            default:
                break
            }
        }
    }

    /// Each clause with the full condition under which it is active: earlier clauses negated, its own condition added.
    private static func clauses(
        of node: IfConfigDeclSyntax, inside conditions: [String]
    ) -> [(IfConfigClauseSyntax, [String])] {
        var earlier: [String] = []
        return node.clauses.map { clause in
            var clauseConditions = conditions + earlier.map { "!(\($0))" }
            if let condition = clause.condition?.trimmedDescription {
                clauseConditions.append("(\(condition))")
                earlier.append(condition)
            }
            return (clause, clauseConditions)
        }
    }
}
