// swift-tools-version: 6.2

import PackageDescription

let package = Package(
    name: "FirstClawKit",
    platforms: [
        .iOS(.v18),
        .macOS(.v15),
    ],
    products: [
        .library(name: "FirstClawProtocol", targets: ["FirstClawProtocol"]),
        .library(name: "FirstClawKit", targets: ["FirstClawKit"]),
        .library(name: "FirstClawChatUI", targets: ["FirstClawChatUI"]),
    ],
    dependencies: [
        .package(url: "https://github.com/steipete/ElevenLabsKit", exact: "0.1.0"),
        .package(url: "https://github.com/gonzalezreal/textual", exact: "0.3.1"),
    ],
    targets: [
        .target(
            name: "FirstClawProtocol",
            path: "Sources/FirstClawProtocol",
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .target(
            name: "FirstClawKit",
            dependencies: [
                "FirstClawProtocol",
                .product(name: "ElevenLabsKit", package: "ElevenLabsKit"),
            ],
            path: "Sources/FirstClawKit",
            resources: [
                .process("Resources"),
            ],
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .target(
            name: "FirstClawChatUI",
            dependencies: [
                "FirstClawKit",
                .product(
                    name: "Textual",
                    package: "textual",
                    condition: .when(platforms: [.macOS, .iOS])),
            ],
            path: "Sources/FirstClawChatUI",
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .testTarget(
            name: "FirstClawKitTests",
            dependencies: ["FirstClawKit", "FirstClawChatUI"],
            path: "Tests/FirstClawKitTests",
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
                .enableExperimentalFeature("SwiftTesting"),
            ]),
    ])
