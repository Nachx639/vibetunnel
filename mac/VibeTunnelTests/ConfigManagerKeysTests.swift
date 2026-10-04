import Foundation
import Testing
@testable import VibeTunnel

@Suite("ConfigManager keeps server-owned keys")
struct ConfigManagerKeysTests {
    private func object(_ data: Data) throws -> [String: Any] {
        try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    @Test
    func keepsKeysTheAppDoesNotModel() throws {
        let encoded = Data(#"{"version":2,"quickStartCommands":[]}"#.utf8)
        let onDisk = Data(#"{"version":2,"quickStartCommands":[],"autoCleanupExitedAfterDays":7}"#.utf8)

        let merged = try object(ConfigManager.keepingServerOwnedKeys(in: encoded, from: onDisk))

        #expect(merged["autoCleanupExitedAfterDays"] as? Int == 7)
    }

    @Test
    func theAppsOwnKeysStayItsToClear() throws {
        let encoded = Data(#"{"version":2,"quickStartCommands":[]}"#.utf8)
        let onDisk = Data(#"{"version":2,"quickStartCommands":[],"repositoryBasePath":"~/old"}"#.utf8)

        let merged = try object(ConfigManager.keepingServerOwnedKeys(in: encoded, from: onDisk))

        #expect(merged["repositoryBasePath"] == nil)
    }

    @Test
    func writesWhatItEncodedWhenThereIsNothingToKeep() throws {
        let encoded = Data(#"{"version":2,"quickStartCommands":[]}"#.utf8)

        #expect(try ConfigManager.keepingServerOwnedKeys(in: encoded, from: nil) == encoded)
        #expect(try ConfigManager.keepingServerOwnedKeys(in: encoded, from: Data("not json".utf8)) == encoded)
    }
}
