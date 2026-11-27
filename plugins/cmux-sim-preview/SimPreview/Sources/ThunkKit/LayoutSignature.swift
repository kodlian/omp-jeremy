import SwiftParser
import SwiftSyntax

/// The tokens of a file that a thunk can't swap in, such as stored properties, initializers and type declarations.
/// When it differs from the built version, the app needs a rebuild.
public struct LayoutSignature: Equatable, Sendable {
    private let tokens: [String]

    public init(source: String) {
        let file = Parser.parse(source: source)
        let thunked = SourceStructure(file).thunkedRanges
        tokens = file.tokens(viewMode: .sourceAccurate).compactMap { token in
            let position = token.positionAfterSkippingLeadingTrivia
            return thunked.contains { $0.contains(position) } ? nil : token.text
        }
    }
}
