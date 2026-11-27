/// One target's entry in `xcodebuild -showBuildSettings -json`.
struct TargetSettings: Decodable {
    let buildSettings: [String: String]
}
