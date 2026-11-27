/// `simctl list devices -j` output: devices by runtime identifier.
struct SimulatorDeviceList: Decodable {
    struct Entry: Decodable {
        let udid: String
        let name: String
        let state: String
    }

    let devices: [String: [Entry]]
}
