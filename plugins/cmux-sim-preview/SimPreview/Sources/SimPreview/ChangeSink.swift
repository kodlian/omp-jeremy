/// Carries FSEvents callbacks into an `AsyncStream`.
final class ChangeSink: Sendable {
    let continuation: AsyncStream<Set<String>>.Continuation

    init(continuation: AsyncStream<Set<String>>.Continuation) {
        self.continuation = continuation
    }
}
