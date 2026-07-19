import AppKit
import Foundation

struct NowItem: Codable, Identifiable {
  let kind: String
  let label: String
  let detail: String
  let mainline: String
  let sessionId: String?
  let at: String

  var id: String { "\(kind):\(sessionId ?? mainline):\(at)" }
}

struct SessionMapSnapshot: Codable {
  let revision: Int
  let updatedAt: String
  let activeSessions: Int
  let now: [NowItem]
  let engine: String
}

enum ServicePhase: Equatable {
  case idle
  case starting
  case ready
  case failed(String)
}

@MainActor
final class ServiceModel: ObservableObject {
  static let shared = ServiceModel()

  @Published private(set) var phase: ServicePhase = .idle
  @Published private(set) var snapshot: SessionMapSnapshot?

  let baseURL = URL(string: "http://127.0.0.1:4317")!
  private var started = false
  private var pollingTask: Task<Void, Never>?
  private var fallbackProcess: Process?

  var statusLine: String {
    switch phase {
    case .idle: return "尚未启动"
    case .starting: return "正在连接本地思维树…"
    case .failed(let message): return message
    case .ready:
      guard let snapshot else { return "服务已就绪" }
      return "\(snapshot.activeSessions) 个活跃 session · \(relativeTime(snapshot.updatedAt))"
    }
  }

  var isReady: Bool { phase == .ready }

  func start() {
    guard !started else { return }
    started = true
    pollingTask = Task { [weak self] in
      guard let self else { return }
      await self.ensureService()
      while !Task.isCancelled {
        if self.isReady {
          await self.refreshSnapshot()
        } else if await self.healthCheck() {
          self.phase = .ready
          await self.refreshSnapshot()
          NotificationCenter.default.post(name: .sessionMapReload, object: nil)
        }
        try? await Task.sleep(nanoseconds: 4_000_000_000)
      }
    }
  }

  func repairService() {
    phase = .starting
    Task { [weak self] in
      guard let self else { return }
      do {
        try await self.installService()
        guard await self.waitForHealth() else {
          throw ServiceError.message("后台服务未能启动")
        }
        self.phase = .ready
        await self.refreshSnapshot()
        NotificationCenter.default.post(name: .sessionMapReload, object: nil)
      } catch {
        self.phase = .failed(error.localizedDescription)
      }
    }
  }

  func openBrowser() {
    if let url = authenticatedURL() { NSWorkspace.shared.open(url) }
  }

  func authenticatedURL(shell: Bool = false) -> URL? {
    let tokenURL = FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent("Library/Application Support/SessionMap/capability.token")
    guard let token = try? String(contentsOf: tokenURL, encoding: .utf8)
      .trimmingCharacters(in: .whitespacesAndNewlines),
      token.range(of: "^[A-Za-z0-9_-]{43,128}$", options: .regularExpression) != nil else { return nil }
    var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)
    if shell { components?.queryItems = [URLQueryItem(name: "shell", value: "mac")] }
    components?.fragment = "cap=\(token)"
    return components?.url
  }

  func fitMap() {
    NotificationCenter.default.post(name: .sessionMapFit, object: nil)
  }

  func reloadMap() {
    NotificationCenter.default.post(name: .sessionMapReload, object: nil)
  }

  private func ensureService() async {
    phase = .starting
    if await healthCheck() {
      phase = .ready
      await refreshSnapshot()
      return
    }
    do {
      try await installService()
      if !(await waitForHealth()) {
        try startFallbackService()
        guard await waitForHealth() else {
          throw ServiceError.message("无法连接 SessionMap 后台服务")
        }
      }
      phase = .ready
      await refreshSnapshot()
    } catch {
      phase = .failed(error.localizedDescription)
    }
  }

  private func executableURL() throws -> URL {
    if let bundled = Bundle.main.url(forResource: "sessionmap", withExtension: nil, subdirectory: "bin"),
       FileManager.default.isExecutableFile(atPath: bundled.path) {
      return bundled
    }
    let installed = FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent(".local/bin/sessionmap")
    if FileManager.default.isExecutableFile(atPath: installed.path) { return installed }
    throw ServiceError.message("应用内缺少 sessionmap 可执行文件")
  }

  private func installService() async throws {
    let output = try await run(executableURL(), arguments: ["install"])
    if output.status != 0 {
      let stderr = output.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
      let stdout = output.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
      throw ServiceError.message(stderr.isEmpty ? (stdout.isEmpty ? "后台服务安装失败" : stdout) : stderr)
    }
  }

  private func startFallbackService() throws {
    if fallbackProcess?.isRunning == true { return }
    let process = Process()
    process.executableURL = try executableURL()
    process.arguments = ["serve", "--no-open"]
    process.currentDirectoryURL = FileManager.default.homeDirectoryForCurrentUser
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    try process.run()
    fallbackProcess = process
  }

  private func run(_ executable: URL, arguments: [String]) async throws -> (status: Int32, stdout: String, stderr: String) {
    try await withCheckedThrowingContinuation { continuation in
      DispatchQueue.global(qos: .userInitiated).async {
        do {
          let process = Process()
          let output = Pipe()
          let errors = Pipe()
          process.executableURL = executable
          process.arguments = arguments
          process.currentDirectoryURL = FileManager.default.homeDirectoryForCurrentUser
          process.standardOutput = output
          process.standardError = errors
          try process.run()
          process.waitUntilExit()
          let stdout = String(data: output.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
          let stderr = String(data: errors.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
          continuation.resume(returning: (process.terminationStatus, stdout, stderr))
        } catch {
          continuation.resume(throwing: error)
        }
      }
    }
  }

  private func healthCheck() async -> Bool {
    var request = URLRequest(url: baseURL.appendingPathComponent("health"))
    request.timeoutInterval = 0.8
    do {
      let (data, response) = try await URLSession.shared.data(for: request)
      guard (response as? HTTPURLResponse)?.statusCode == 200 else { return false }
      let value = try JSONDecoder().decode(HealthResponse.self, from: data)
      return value.ok && value.name == "SessionMap"
    } catch {
      return false
    }
  }

  private func waitForHealth() async -> Bool {
    for _ in 0..<60 {
      if await healthCheck() { return true }
      try? await Task.sleep(nanoseconds: 150_000_000)
    }
    return false
  }

  private func refreshSnapshot() async {
    let tokenURL = FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent("Library/Application Support/SessionMap/capability.token")
    guard let token = try? String(contentsOf: tokenURL, encoding: .utf8)
      .trimmingCharacters(in: .whitespacesAndNewlines), !token.isEmpty else { return }
    var request = URLRequest(url: baseURL.appendingPathComponent("api/snapshot"))
    request.timeoutInterval = 1.5
    request.setValue(token, forHTTPHeaderField: "X-SessionMap-Token")
    do {
      let (data, response) = try await URLSession.shared.data(for: request)
      guard (response as? HTTPURLResponse)?.statusCode == 200 else { return }
      snapshot = try JSONDecoder().decode(SessionMapSnapshot.self, from: data)
    } catch {
      if !(await healthCheck()) { phase = .failed("后台服务连接已断开") }
    }
  }

  private func relativeTime(_ value: String) -> String {
    let formatter = ISO8601DateFormatter()
    guard let date = formatter.date(from: value) else { return "刚刚更新" }
    let seconds = max(0, Date().timeIntervalSince(date))
    if seconds < 45 { return "刚刚更新" }
    if seconds < 3_600 { return "\(Int(seconds / 60)) 分钟前更新" }
    if seconds < 86_400 { return "\(Int(seconds / 3_600)) 小时前更新" }
    return "\(Int(seconds / 86_400)) 天前更新"
  }
}

private struct HealthResponse: Codable {
  let ok: Bool
  let name: String
}

private enum ServiceError: LocalizedError {
  case message(String)

  var errorDescription: String? {
    switch self {
    case .message(let value): return value
    }
  }
}

extension Notification.Name {
  static let sessionMapFit = Notification.Name("SessionMap.fit")
  static let sessionMapReload = Notification.Name("SessionMap.reload")
}
