/// A message from the loader inside the app: `ready`, `shown`, `reloaded`, `previews` or `error`.
struct LoaderEvent: Decodable, Sendable {
    let event: String
    let preview: String?
    let previews: [String]?
    let message: String?
}
