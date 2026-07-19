// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "SessionMapNative",
  platforms: [.macOS(.v13)],
  products: [
    .executable(name: "SessionMap", targets: ["SessionMap"]),
  ],
  targets: [
    .executableTarget(
      name: "SessionMap",
      path: "Sources/SessionMap"
    ),
  ],
  swiftLanguageModes: [.v5]
)
