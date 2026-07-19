import AppKit
import SwiftUI

@main
struct SessionMapDesktopApp: App {
  @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
  @StateObject private var service = ServiceModel.shared

  var body: some Scene {
    WindowGroup(id: "map") {
      MapWindow(service: service)
    }
    .defaultSize(width: 1_420, height: 900)
    .defaultPosition(.center)
    .windowStyle(.hiddenTitleBar)
    .commands {
      CommandMenu("地图") {
        Button("适合视图") { service.fitMap() }
          .keyboardShortcut("0", modifiers: [.command])
        Button("重新载入") { service.reloadMap() }
          .keyboardShortcut("r", modifiers: [.command])
        Divider()
        Button("在浏览器中打开") { service.openBrowser() }
        Button("修复后台服务") { service.repairService() }
      }
    }

    MenuBarExtra {
      MenuPanel(service: service)
    } label: {
      Label("SessionMap", systemImage: "point.3.connected.trianglepath.dotted")
    }
  }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.regular)
    ServiceModel.shared.start()
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    false
  }
}

struct MapWindow: View {
  @ObservedObject var service: ServiceModel

  var body: some View {
    ZStack {
      Color(red: 0.969, green: 0.969, blue: 0.973)
        .ignoresSafeArea()
      if service.isReady {
        MapWebView(service: service)
          .ignoresSafeArea()
      } else {
        StartupView(service: service)
      }
    }
    .background(WindowConfigurator())
    .frame(minWidth: 900, minHeight: 600)
    .onAppear { service.start() }
  }
}

struct StartupView: View {
  @ObservedObject var service: ServiceModel

  var body: some View {
    VStack(spacing: 14) {
      BrandGlyph(size: 42)
      Text("SessionMap")
        .font(.system(size: 20, weight: .semibold))
        .foregroundStyle(Color(red: 0.125, green: 0.129, blue: 0.141))
      Text(service.statusLine)
        .font(.system(size: 12))
        .foregroundStyle(.secondary)
      if case .failed = service.phase {
        Button("修复后台服务") { service.repairService() }
          .buttonStyle(.borderedProminent)
          .tint(Color(red: 0.35, green: 0.38, blue: 0.45))
      } else {
        ProgressView()
          .controlSize(.small)
      }
    }
    .padding(36)
  }
}

struct MenuPanel: View {
  @ObservedObject var service: ServiceModel
  @Environment(\.openWindow) private var openWindow

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 8) {
        BrandGlyph(size: 22)
        VStack(alignment: .leading, spacing: 1) {
          Text("SessionMap").font(.system(size: 13, weight: .semibold))
          Text(service.statusLine).font(.system(size: 10)).foregroundStyle(.secondary)
        }
      }

      if let items = service.snapshot?.now.prefix(3), !items.isEmpty {
        Divider()
        ForEach(Array(items)) { item in
          HStack(alignment: .top, spacing: 8) {
            Circle()
              .fill(color(for: item.kind))
              .frame(width: 6, height: 6)
              .padding(.top, 5)
            VStack(alignment: .leading, spacing: 1) {
              Text(item.label).font(.system(size: 11, weight: .semibold))
              Text(item.detail.isEmpty ? item.mainline : item.detail)
                .font(.system(size: 10))
                .foregroundStyle(.secondary)
                .lineLimit(1)
            }
          }
        }
      }

      Divider()
      Button("打开思维地图") {
        openWindow(id: "map")
        NSApp.activate(ignoringOtherApps: true)
      }
      .keyboardShortcut("m", modifiers: [.command, .option])
      Button("在浏览器中打开") { service.openBrowser() }
      Button("修复后台服务") { service.repairService() }
      Divider()
      Button("退出 SessionMap") { NSApp.terminate(nil) }
    }
    .padding(12)
    .frame(width: 290)
  }

  private func color(for kind: String) -> Color {
    switch kind {
    case "decision": return Color(red: 0.706, green: 0.137, blue: 0.227)
    case "reply": return Color(red: 0.604, green: 0.357, blue: 0)
    case "blocker": return Color(red: 0.761, green: 0.255, blue: 0.231)
    case "busy": return Color(red: 0.094, green: 0.451, blue: 0.294)
    default: return Color(red: 0.435, green: 0.333, blue: 0.78)
    }
  }
}

struct BrandGlyph: View {
  let size: CGFloat

  var body: some View {
    ZStack {
      Path { path in
        path.move(to: CGPoint(x: size * 0.2, y: size * 0.56))
        path.addLine(to: CGPoint(x: size * 0.54, y: size * 0.33))
        path.move(to: CGPoint(x: size * 0.54, y: size * 0.33))
        path.addLine(to: CGPoint(x: size * 0.82, y: size * 0.62))
      }
      .stroke(Color(red: 0.48, green: 0.51, blue: 0.57), lineWidth: max(1, size * 0.045))
      Circle().fill(Color(red: 0.125, green: 0.129, blue: 0.141))
        .frame(width: size * 0.16, height: size * 0.16)
        .position(x: size * 0.2, y: size * 0.56)
      Circle().fill(Color(red: 0.435, green: 0.333, blue: 0.78))
        .frame(width: size * 0.18, height: size * 0.18)
        .position(x: size * 0.54, y: size * 0.33)
      Circle().fill(Color(red: 0.094, green: 0.451, blue: 0.294))
        .frame(width: size * 0.16, height: size * 0.16)
        .position(x: size * 0.82, y: size * 0.62)
    }
    .frame(width: size, height: size)
    .accessibilityHidden(true)
  }
}

struct WindowConfigurator: NSViewRepresentable {
  func makeNSView(context: Context) -> NSView {
    let view = NSView()
    DispatchQueue.main.async { configure(view.window) }
    return view
  }

  func updateNSView(_ nsView: NSView, context: Context) {
    DispatchQueue.main.async { configure(nsView.window) }
  }

  private func configure(_ window: NSWindow?) {
    guard let window else { return }
    window.title = "SessionMap"
    window.titleVisibility = .hidden
    window.titlebarAppearsTransparent = true
    window.styleMask.insert(.fullSizeContentView)
    window.isMovableByWindowBackground = false
    window.backgroundColor = NSColor(red: 0.969, green: 0.969, blue: 0.973, alpha: 1)
    window.minSize = NSSize(width: 900, height: 600)
    window.tabbingMode = .disallowed
  }
}
