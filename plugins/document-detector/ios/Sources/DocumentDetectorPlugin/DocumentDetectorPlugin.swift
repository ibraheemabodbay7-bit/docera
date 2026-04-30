import Capacitor
import Foundation
import Vision

@objc(DocumentDetectorPlugin)
public class DocumentDetectorPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "DocumentDetectorPlugin"
    public let jsName = "DocumentDetector"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "detectFromImage", returnType: CAPPluginReturnPromise)
    ]

    @objc func detectFromImage(_ call: CAPPluginCall) {
        guard let path = call.getString("path") else {
            call.reject("Missing path parameter")
            return
        }

        // Normalise to a plain filesystem path — accept file://, capacitor://, or bare path
        let filePath: String
        if path.hasPrefix("capacitor://localhost/_capacitor_file_/") {
            filePath = String(path.dropFirst("capacitor://localhost/_capacitor_file_/".count))
        } else if path.hasPrefix("file://") {
            filePath = String(path.dropFirst("file://".count))
        } else {
            filePath = path
        }

        guard let image = UIImage(contentsOfFile: filePath),
              let cgImage = image.cgImage else {
            call.resolve(["quad": NSNull()])
            return
        }

        DispatchQueue.global(qos: .userInitiated).async {
            let request = VNDetectDocumentSegmentationRequest()
            let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])

            do {
                try handler.perform([request])
            } catch {
                call.resolve(["quad": NSNull()])
                return
            }

            guard let observation = request.results?.first else {
                call.resolve(["quad": NSNull()])
                return
            }

            // Vision coordinates: origin at bottom-left, y increases upward.
            // Flip Y so origin is top-left (web/CSS coordinate space).
            let tl = observation.topLeft
            let tr = observation.topRight
            let bl = observation.bottomLeft
            let br = observation.bottomRight

            let quad: JSObject = [
                "tl": ["x": Double(tl.x), "y": Double(1.0 - tl.y)] as JSObject,
                "tr": ["x": Double(tr.x), "y": Double(1.0 - tr.y)] as JSObject,
                "bl": ["x": Double(bl.x), "y": Double(1.0 - bl.y)] as JSObject,
                "br": ["x": Double(br.x), "y": Double(1.0 - br.y)] as JSObject
            ]

            call.resolve(["quad": quad])
        }
    }
}
