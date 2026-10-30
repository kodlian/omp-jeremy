/// `cmux ios list --json` output.
struct CmuxSimulatorList: Decodable {
    struct Target: Decodable {
        let surfaceRef: String

        private enum CodingKeys: String, CodingKey {
            case surfaceRef = "surface_ref"
        }
    }

    let targets: [Target]
}
