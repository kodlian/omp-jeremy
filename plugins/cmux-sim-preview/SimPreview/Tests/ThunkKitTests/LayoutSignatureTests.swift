import Testing
import ThunkKit

struct LayoutSignatureTests {
    private let original = """
        import SwiftUI

        struct CounterView: View {
            @State private var count = 0

            var body: some View {
                Text(count, format: .number)
            }

            private func increment() {
                count += 1
            }
        }

        #Preview("Counter") {
            CounterView()
        }
        """

    @Test(arguments: [
        ("Text(count, format: .number)", "VStack { Text(\"Count\"); Text(count, format: .number) }"),
        ("count += 1", "count += 2"),
        ("    CounterView()\n}", "    CounterView()\n        .padding()\n}"),
        ("import SwiftUI", "import SwiftUI\nimport Charts"),
        ("struct CounterView", "// A counter.\nstruct CounterView"),
    ])
    func editsThunksCanCarryKeepTheLayout(edit: (String, String)) {
        let edited = original.replacing(edit.0, with: edit.1)
        #expect(edited != original)
        #expect(LayoutSignature(source: edited) == LayoutSignature(source: original))
    }

    @Test(arguments: [
        ("@State private var count = 0", "@State private var count = 5"),
        ("@State private var count = 0", "@State private var count = 0\n    @State private var step = 1"),
        ("private func increment()", "private func increment(by step: Int = 1)"),
        ("struct CounterView: View", "struct CounterView: View, Equatable"),
    ])
    func editsBeyondBodiesChangeTheLayout(edit: (String, String)) {
        let edited = original.replacing(edit.0, with: edit.1)
        #expect(edited != original)
        #expect(LayoutSignature(source: edited) != LayoutSignature(source: original))
    }
}
