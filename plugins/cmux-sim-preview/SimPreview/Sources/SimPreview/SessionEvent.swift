/// Inputs a preview session handles one at a time.
enum SessionEvent: Sendable {
    case loader(LoaderEvent)
    case command(String)
    case deviceSelected(String?)
    case sourcesChanged(Set<String>)
}
