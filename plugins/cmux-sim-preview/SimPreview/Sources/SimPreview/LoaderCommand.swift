/// A message to the loader inside the app.
struct LoaderCommand: Encodable, Sendable {
    let command: String
    var preview: String?
    var dylib: String?
    var file: String?

    static func show(_ preview: String) -> LoaderCommand {
        LoaderCommand(command: "show", preview: preview)
    }

    /// Loads a thunk whose #Previews stand in for those of `file`.
    static func reload(dylib: String, file: String) -> LoaderCommand {
        LoaderCommand(command: "reload", dylib: dylib, file: file)
    }
}
