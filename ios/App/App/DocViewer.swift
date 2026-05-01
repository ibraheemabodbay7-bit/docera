import Foundation
import Capacitor
import QuickLook

@objc(DocViewerPlugin)
public class DocViewerPlugin: CAPPlugin, QLPreviewControllerDataSource {
  private var previewURL: URL?

  @objc func openFile(_ call: CAPPluginCall) {
    guard let filePath = call.getString("filePath") else {
      call.reject("Missing filePath")
      return
    }
    let filePathClean = filePath.hasPrefix("file://") ? String(filePath.dropFirst(7)) : filePath
    let url = URL(fileURLWithPath: filePathClean)
    self.previewURL = url
    DispatchQueue.main.async {
      let preview = QLPreviewController()
      preview.dataSource = self
      self.bridge?.viewController?.present(preview, animated: true)
      call.resolve()
    }
  }

  public func numberOfPreviewItems(in controller: QLPreviewController) -> Int {
    return previewURL != nil ? 1 : 0
  }

  public func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem {
    return previewURL! as QLPreviewItem
  }
}
