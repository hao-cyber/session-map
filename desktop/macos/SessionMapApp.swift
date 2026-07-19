import AppKit
import WebKit

private let serviceURL = URL(string: "http://127.0.0.1:4317/")!
private let keepAboveKey = "SessionMapKeepWindowAbove"

private struct CommandResult {
    let ok: Bool
    let output: String
}

final class SessionMapApp: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var loading: NSStackView!
    private var loadingLabel: NSTextField!
    private var opening = false
    private var keepAboveItem: NSMenuItem!

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()
        buildWindow()
        showMap(nil)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showMap(nil)
        return true
    }

    @objc private func showMap(_ sender: Any?) {
        showWindow()
        guard !opening else { return }
        opening = true
        showLoading("正在连接本机 SessionMap…")
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            var error = ""
            if !self.serviceHealthy() {
                guard let cli = self.cliURL() else {
                    error = "找不到 sessionmap CLI。请重新安装 SessionMap.pkg，或运行 bun run build:app。"
                    DispatchQueue.main.async { self.finishOpening(error: error) }
                    return
                }
                let installed = self.run(cli, ["install"])
                if !installed.ok {
                    error = installed.output.isEmpty ? "SessionMap 后台服务安装失败。" : installed.output
                }
            }
            DispatchQueue.main.async { self.finishOpening(error: error) }
        }
    }

    private func finishOpening(error: String) {
        opening = false
        if error.isEmpty {
            load(serviceURL)
        } else {
            showLoading(error, failed: true)
        }
    }

    private func load(_ url: URL) {
        guard isAllowedURL(url) else { return }
        showLoading("正在读取工作线…")
        webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData))
    }

    private func serviceHealthy() -> Bool {
        let result = run(URL(fileURLWithPath: "/usr/bin/curl"), [
            "--fail", "--silent", "--show-error", "--max-time", "1",
            "http://127.0.0.1:4317/health",
        ])
        return result.ok && result.output.contains("SessionMap")
    }

    private func cliURL() -> URL? {
        let manager = FileManager.default
        var candidates: [String] = []
        if let override = ProcessInfo.processInfo.environment["SESSIONMAP_CLI_PATH"], !override.isEmpty {
            candidates.append(override)
        }
        candidates.append((NSHomeDirectory() as NSString).appendingPathComponent(".local/bin/sessionmap"))
        candidates.append("/usr/local/libexec/sessionmap/sessionmap")
        if let resource = Bundle.main.resourceURL {
            candidates.append(resource.appendingPathComponent("bin/sessionmap").path)
        }
        return candidates.first(where: { manager.isExecutableFile(atPath: $0) }).map(URL.init(fileURLWithPath:))
    }

    private func run(_ executable: URL, _ arguments: [String]) -> CommandResult {
        let process = Process()
        let pipe = Pipe()
        process.executableURL = executable
        process.arguments = arguments
        process.standardOutput = pipe
        process.standardError = pipe
        process.standardInput = FileHandle.nullDevice
        do {
            try process.run()
            process.waitUntilExit()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            return CommandResult(
                ok: process.terminationStatus == 0,
                output: String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            )
        } catch {
            return CommandResult(ok: false, output: error.localizedDescription)
        }
    }

    private func isAllowedURL(_ url: URL) -> Bool {
        url.scheme == "http" && url.host == "127.0.0.1" && (url.port ?? 80) == 4317
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }
        if isAllowedURL(url) {
            decisionHandler(.allow)
        } else {
            if navigationAction.navigationType == .linkActivated {
                NSWorkspace.shared.open(url)
            }
            decisionHandler(.cancel)
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loading.isHidden = true
        webView.isHidden = false
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        showLoading("页面暂时无法打开：\(error.localizedDescription)", failed: true)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        showLoading("本机服务暂时无法连接：\(error.localizedDescription)", failed: true)
    }

    private func buildWindow() {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.isHidden = true
        webView.underPageBackgroundColor = NSColor(calibratedWhite: 0.97, alpha: 1)

        let progress = NSProgressIndicator()
        progress.style = .spinning
        progress.startAnimation(nil)
        loadingLabel = NSTextField(labelWithString: "正在打开 SessionMap…")
        loadingLabel.textColor = .secondaryLabelColor
        loadingLabel.alignment = .center
        loadingLabel.maximumNumberOfLines = 3
        loading = NSStackView(views: [progress, loadingLabel])
        loading.orientation = .vertical
        loading.alignment = .centerX
        loading.spacing = 14

        let content = NSView()
        content.wantsLayer = true
        content.layer?.backgroundColor = NSColor(calibratedWhite: 0.97, alpha: 1).cgColor
        for view in [webView as NSView, loading as NSView] {
            view.translatesAutoresizingMaskIntoConstraints = false
            content.addSubview(view)
        }
        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            webView.topAnchor.constraint(equalTo: content.topAnchor),
            webView.bottomAnchor.constraint(equalTo: content.bottomAnchor),
            loading.centerXAnchor.constraint(equalTo: content.centerXAnchor),
            loading.centerYAnchor.constraint(equalTo: content.centerYAnchor),
            loading.leadingAnchor.constraint(greaterThanOrEqualTo: content.leadingAnchor, constant: 40),
            loading.trailingAnchor.constraint(lessThanOrEqualTo: content.trailingAnchor, constant: -40),
        ])

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1180, height: 800),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "SessionMap"
        window.contentView = content
        window.delegate = self
        window.isReleasedWhenClosed = false
        window.minSize = NSSize(width: 760, height: 520)
        window.setFrameAutosaveName("SessionMapMainWindow")
        window.center()
        applyKeepAbove(UserDefaults.standard.bool(forKey: keepAboveKey))
    }

    private func buildMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem(title: "SessionMap", action: nil, keyEquivalent: "")
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "关于 SessionMap", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "退出 SessionMap", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        main.addItem(appItem)
        main.setSubmenu(appMenu, for: appItem)

        let windowItem = NSMenuItem(title: "窗口", action: nil, keyEquivalent: "")
        let windowMenu = NSMenu(title: "窗口")
        let show = windowMenu.addItem(withTitle: "显示 SessionMap", action: #selector(showMap(_:)), keyEquivalent: "m")
        show.keyEquivalentModifierMask = [.command, .shift]
        show.target = self
        keepAboveItem = windowMenu.addItem(withTitle: "保持在最前面", action: #selector(toggleKeepAbove(_:)), keyEquivalent: "")
        keepAboveItem.target = self
        windowMenu.addItem(.separator())
        windowMenu.addItem(withTitle: "最小化", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        main.addItem(windowItem)
        main.setSubmenu(windowMenu, for: windowItem)
        NSApp.mainMenu = main
    }

    @objc private func toggleKeepAbove(_ sender: Any?) {
        applyKeepAbove(window.level != .floating)
    }

    private func applyKeepAbove(_ enabled: Bool) {
        window?.level = enabled ? .floating : .normal
        keepAboveItem?.state = enabled ? .on : .off
        UserDefaults.standard.set(enabled, forKey: keepAboveKey)
    }

    private func showWindow() {
        if window == nil { return }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func showLoading(_ message: String, failed: Bool = false) {
        loadingLabel.stringValue = message
        loadingLabel.textColor = failed ? .systemRed : .secondaryLabelColor
        loading.isHidden = false
        webView.isHidden = true
    }
}

@main
private enum SessionMapMain {
    static func main() {
        let application = NSApplication.shared
        let delegate = SessionMapApp()
        application.delegate = delegate
        application.setActivationPolicy(.regular)
        application.run()
        withExtendedLifetime(delegate) {}
    }
}
