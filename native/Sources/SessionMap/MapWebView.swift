import SwiftUI
import WebKit

struct MapWebView: NSViewRepresentable {
  @ObservedObject var service: ServiceModel

  func makeCoordinator() -> Coordinator { Coordinator() }

  func makeNSView(context: Context) -> WKWebView {
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .default()
    configuration.applicationNameForUserAgent = "SessionMapMac/0.1"
    let webView = WKWebView(frame: .zero, configuration: configuration)
    webView.navigationDelegate = context.coordinator
    webView.setValue(false, forKey: "drawsBackground")
    webView.allowsMagnification = false
    context.coordinator.attach(webView)
    return webView
  }

  func updateNSView(_ webView: WKWebView, context: Context) {
    guard service.isReady, !context.coordinator.hasLoaded else { return }
    guard let url = service.authenticatedURL(shell: true) else { return }
    webView.load(URLRequest(url: url))
    context.coordinator.hasLoaded = true
  }

  final class Coordinator: NSObject, WKNavigationDelegate {
    var hasLoaded = false
    private weak var webView: WKWebView?
    private var observers: [NSObjectProtocol] = []

    override init() {
      super.init()
      observers.append(NotificationCenter.default.addObserver(
        forName: .sessionMapFit,
        object: nil,
        queue: .main
      ) { [weak self] _ in
        self?.webView?.evaluateJavaScript("window.SESSIONMAP_FIT && window.SESSIONMAP_FIT()")
      })
      observers.append(NotificationCenter.default.addObserver(
        forName: .sessionMapReload,
        object: nil,
        queue: .main
      ) { [weak self] _ in
        self?.webView?.reload()
      })
    }

    deinit {
      for observer in observers { NotificationCenter.default.removeObserver(observer) }
    }

    func attach(_ webView: WKWebView) {
      self.webView = webView
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
      webView.reload()
    }
  }
}
