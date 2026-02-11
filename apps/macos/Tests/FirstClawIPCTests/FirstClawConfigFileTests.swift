import Foundation
import Testing
@testable import FirstClaw

@Suite(.serialized)
struct FirstClawConfigFileTests {
    @Test
    func configPathRespectsEnvOverride() async {
        let override = FileManager().temporaryDirectory
            .appendingPathComponent("firstclaw-config-\(UUID().uuidString)")
            .appendingPathComponent("firstclaw.json")
            .path

        await TestIsolation.withEnvValues(["FIRSTCLAW_CONFIG_PATH": override]) {
            #expect(FirstClawConfigFile.url().path == override)
        }
    }

    @MainActor
    @Test
    func remoteGatewayPortParsesAndMatchesHost() async {
        let override = FileManager().temporaryDirectory
            .appendingPathComponent("firstclaw-config-\(UUID().uuidString)")
            .appendingPathComponent("firstclaw.json")
            .path

        await TestIsolation.withEnvValues(["FIRSTCLAW_CONFIG_PATH": override]) {
            FirstClawConfigFile.saveDict([
                "gateway": [
                    "remote": [
                        "url": "ws://gateway.ts.net:19999",
                    ],
                ],
            ])
            #expect(FirstClawConfigFile.remoteGatewayPort() == 19999)
            #expect(FirstClawConfigFile.remoteGatewayPort(matchingHost: "gateway.ts.net") == 19999)
            #expect(FirstClawConfigFile.remoteGatewayPort(matchingHost: "gateway") == 19999)
            #expect(FirstClawConfigFile.remoteGatewayPort(matchingHost: "other.ts.net") == nil)
        }
    }

    @MainActor
    @Test
    func setRemoteGatewayUrlPreservesScheme() async {
        let override = FileManager().temporaryDirectory
            .appendingPathComponent("firstclaw-config-\(UUID().uuidString)")
            .appendingPathComponent("firstclaw.json")
            .path

        await TestIsolation.withEnvValues(["FIRSTCLAW_CONFIG_PATH": override]) {
            FirstClawConfigFile.saveDict([
                "gateway": [
                    "remote": [
                        "url": "wss://old-host:111",
                    ],
                ],
            ])
            FirstClawConfigFile.setRemoteGatewayUrl(host: "new-host", port: 2222)
            let root = FirstClawConfigFile.loadDict()
            let url = ((root["gateway"] as? [String: Any])?["remote"] as? [String: Any])?["url"] as? String
            #expect(url == "wss://new-host:2222")
        }
    }

    @Test
    func stateDirOverrideSetsConfigPath() async {
        let dir = FileManager().temporaryDirectory
            .appendingPathComponent("firstclaw-state-\(UUID().uuidString)", isDirectory: true)
            .path

        await TestIsolation.withEnvValues([
            "FIRSTCLAW_CONFIG_PATH": nil,
            "FIRSTCLAW_STATE_DIR": dir,
        ]) {
            #expect(FirstClawConfigFile.stateDirURL().path == dir)
            #expect(FirstClawConfigFile.url().path == "\(dir)/firstclaw.json")
        }
    }
}
