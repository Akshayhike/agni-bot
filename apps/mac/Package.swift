// swift-tools-version: 6.0
import Foundation
import PackageDescription

/// Command Line Tools–only toolchains resolve Testing.framework but not its
/// macro plugin: `swiftc -print-target-info` there has no Swift Testing entry,
/// so SwiftPM never passes the plugin path and `@Test` / `@Suite` fail to
/// expand. Point the test targets at the plugin ourselves; with Xcode
/// installed this resolves to Xcode's copy, which is what SwiftPM uses anyway.
let developerDir =
  (try? FileManager.default.destinationOfSymbolicLink(atPath: "/var/db/xcode_select_link"))
  ?? "/Library/Developer/CommandLineTools"
let swiftTestingPluginPath = developerDir + "/usr/lib/swift/host/plugins/testing"
let swiftTestingSettings: [SwiftSetting] =
  FileManager.default.fileExists(atPath: swiftTestingPluginPath + "/libTestingMacros.dylib")
  ? [.unsafeFlags(["-plugin-path", swiftTestingPluginPath])] : []

let package = Package(
  name: "AgniMac",
  platforms: [.macOS(.v15)],
  products: [
    .executable(name: "Agni", targets: ["AgniApp"]),
    .executable(name: "agni-probe", targets: ["AgniProbe"]),
    .library(name: "AgniKit", targets: ["AgniKit"]),
  ],
  targets: [
    // Wire contract, mirroring packages/protocol/src/frames.ts by hand.
    .target(name: "AgniProtocol"),
    // Connection, transcript state, persistence. No UI.
    .target(name: "AgniKit", dependencies: ["AgniProtocol"]),
    // The Mac app.
    .executableTarget(name: "AgniApp", dependencies: ["AgniKit", "AgniProtocol"]),
    // Headless proof client: connect, send, stream, print frames.
    .executableTarget(name: "AgniProbe", dependencies: ["AgniKit"]),
    .testTarget(
      name: "AgniProtocolTests",
      dependencies: ["AgniProtocol"],
      swiftSettings: swiftTestingSettings
    ),
    .testTarget(
      name: "AgniKitTests",
      dependencies: ["AgniKit", "AgniProtocol"],
      swiftSettings: swiftTestingSettings
    ),
  ]
)
