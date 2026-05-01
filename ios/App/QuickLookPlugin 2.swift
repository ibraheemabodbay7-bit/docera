import Foundation
import Capacitor
import QuickLook

@objc(QuickLookPlugin)
public class QuickLookPlugin: CAPPlugin {
    @objc func openPDF(_ call: CAPPluginCall) {
        guard let path = call.getString("path") else {
            call.reject("Missing path")
            return
        }
        let cleanPath = path.hasPrefix("file://") ? String(path.dropFirst(7)) : path
        let fileURL = URL(fileURLWithPath: cleanPath)
        guard FileManager.default.fileExists(atPath: cleanPath) else {
            call.reject("File does not exist at path: \(cleanPath)")
            return
        }
        DispatchQueue.main.async {
            let preview = QLPreviewController()
            let dataSource = QuickLookDataSource(url: fileURL)
            preview.dataSource = dataSource
            preview.currentPreviewItemIndex = 0
            if let rootVC = UIApplication.shared.windows.first?.rootViewController {
                var topVC = rootVC
                while let presented = topVC.presentedViewController {
                    topVC = presented
                }
                topVC.present(preview, animated: true) {
                    call.resolve()
                }
            } else {
                call.reject("Could not find root view controller")
            }
        }
    }
}

class QuickLookDataSource: NSObject, QLPreviewControllerDataSource {
    let url: URL
    init(url: URL) { self.url = url }
    func numberOfPreviewItems(in controller: QLPreviewController) -> Int { return 1 }
    func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem {
        return url as QLPreviewItem
    }
}
