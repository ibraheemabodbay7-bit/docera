import Foundation
import Capacitor
import QuickLook

@objc(QuickLookPlugin) public class QuickLookPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "QuickLookPlugin"
    public let jsName = "QuickLook"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "openPDF", returnType: CAPPluginReturnPromise)
    ]

    @objc public func openPDF(_ call: CAPPluginCall) {
        print("QuickLookPlugin: openPDF called")
        guard let path = call.getString("path") else {
            print("QuickLookPlugin: missing path arg")
            call.reject("Missing path")
            return
        }
        var cleanPath = path
        if cleanPath.hasPrefix("file://") {
            cleanPath = String(cleanPath.dropFirst(7))
        }
        cleanPath = cleanPath.removingPercentEncoding ?? cleanPath

        let fileURL = URL(fileURLWithPath: cleanPath)
        guard FileManager.default.fileExists(atPath: cleanPath) else {
            call.reject("File does not exist: \(cleanPath)")
            return
        }

        DispatchQueue.main.async {
            let preview = QLPreviewController()
            let dataSource = QuickLookDataSource(url: fileURL)
            preview.dataSource = dataSource

            guard let vc = self.bridge?.viewController else {
                call.reject("Could not find view controller")
                return
            }
            var topVC = vc
            while let presented = topVC.presentedViewController {
                topVC = presented
            }
            topVC.present(preview, animated: true) {
                call.resolve()
            }
        }
    }
}

private class QuickLookDataSource: NSObject, QLPreviewControllerDataSource {
    let url: URL
    init(url: URL) { self.url = url }
    func numberOfPreviewItems(in controller: QLPreviewController) -> Int { return 1 }
    func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem {
        return url as QLPreviewItem
    }
}
