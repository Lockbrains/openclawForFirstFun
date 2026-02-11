// swift-tools-version: 6.2
// Package manifest for the FirstClaw macOS companion (menu bar app + IPC library).

import PackageDescription

let package = Package(
    name: "FirstClaw",
    platforms: [
        .macOS(.v15),
    ],
    products: [
        .library(name: "FirstClawIPC", targets: ["FirstClawIPC"]),
        .library(name: "FirstClawDiscovery", targets: ["FirstClawDiscovery"]),
        .executable(name: "FirstClaw", targets: ["FirstClaw"]),
        .executable(name: "firstclaw-mac", targets: ["FirstClawMacCLI"]),
    ],
    dependencies: [
        .package(url: "https://github.com/orchetect/MenuBarExtraAccess", exact: "1.2.2"),
        .package(url: "https://github.com/swiftlang/swift-subprocess.git", from: "0.1.0"),
        .package(url: "https://github.com/apple/swift-log.git", from: "1.8.0"),
        .package(url: "https://github.com/sparkle-project/Sparkle", from: "2.8.1"),
        .package(url: "https://github.com/steipete/Peekaboo.git", branch: "main"),
        .package(path: "../shared/FirstClawKit"),
        .package(path: "../../Swabble"),
    ],
    targets: [
        .target(
            name: "FirstClawIPC",
            dependencies: [],
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .target(
            name: "FirstClawDiscovery",
            dependencies: [
                .product(name: "FirstClawKit", package: "FirstClawKit"),
            ],
            path: "Sources/FirstClawDiscovery",
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .executableTarget(
            name: "FirstClaw",
            dependencies: [
                "FirstClawIPC",
                "FirstClawDiscovery",
                .product(name: "FirstClawKit", package: "FirstClawKit"),
                .product(name: "FirstClawChatUI", package: "FirstClawKit"),
                .product(name: "FirstClawProtocol", package: "FirstClawKit"),
                .product(name: "SwabbleKit", package: "swabble"),
                .product(name: "MenuBarExtraAccess", package: "MenuBarExtraAccess"),
                .product(name: "Subprocess", package: "swift-subprocess"),
                .product(name: "Logging", package: "swift-log"),
                .product(name: "Sparkle", package: "Sparkle"),
                .product(name: "PeekabooBridge", package: "Peekaboo"),
                .product(name: "PeekabooAutomationKit", package: "Peekaboo"),
            ],
            exclude: [
                "Resources/Info.plist",
            ],
            resources: [
                .copy("Resources/FirstClaw.icns"),
                .copy("Resources/DeviceModels"),
            ],
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .executableTarget(
            name: "FirstClawMacCLI",
            dependencies: [
                "FirstClawDiscovery",
                .product(name: "FirstClawKit", package: "FirstClawKit"),
                .product(name: "FirstClawProtocol", package: "FirstClawKit"),
            ],
            path: "Sources/FirstClawMacCLI",
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .testTarget(
            name: "FirstClawIPCTests",
            dependencies: [
                "FirstClawIPC",
                "FirstClaw",
                "FirstClawDiscovery",
                .product(name: "FirstClawProtocol", package: "FirstClawKit"),
                .product(name: "SwabbleKit", package: "swabble"),
            ],
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
                .enableExperimentalFeature("SwiftTesting"),
            ]),
    ])
