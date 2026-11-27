/// The scheme's app: where the build puts it and its bundle identifier.
struct ApplicationProduct: Codable, Sendable {
    let path: String
    let bundleIdentifier: String
}
