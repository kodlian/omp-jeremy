// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "SimPreview",
    platforms: [.macOS(.v15)],
    products: [
        .executable(name: "sim-preview", targets: ["SimPreview"]),
    ],
    dependencies: [
        .package(url: "https://github.com/swiftlang/swift-syntax.git", from: "604.0.0"),
        .package(url: "https://github.com/apple/swift-async-algorithms.git", from: "1.1.0"),
    ],
    targets: [
        .target(name: "ThunkKit", dependencies: [
            .product(name: "SwiftParser", package: "swift-syntax"),
            .product(name: "SwiftSyntax", package: "swift-syntax"),
        ]),
        .executableTarget(name: "SimPreview", dependencies: [
            "ThunkKit",
            .product(name: "AsyncAlgorithms", package: "swift-async-algorithms"),
        ]),
        .testTarget(name: "ThunkKitTests", dependencies: ["ThunkKit"]),
    ]
)
