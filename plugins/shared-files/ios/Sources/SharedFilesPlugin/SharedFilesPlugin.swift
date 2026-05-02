import Capacitor
import Foundation

@objc(SharedFilesPlugin)
public class SharedFilesPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SharedFilesPlugin"
    public let jsName = "SharedFiles"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getPendingFiles",   returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearPendingFiles", returnType: CAPPluginReturnPromise),
    ]

    @objc public func getPendingFiles(_ call: CAPPluginCall) {
        let defaults = UserDefaults(suiteName: "group.com.docera.app")
        let paths = defaults?.stringArray(forKey: "pendingSharedFiles") ?? []
        call.resolve(["paths": paths])
    }

    @objc public func clearPendingFiles(_ call: CAPPluginCall) {
        let defaults = UserDefaults(suiteName: "group.com.docera.app")
        defaults?.removeObject(forKey: "pendingSharedFiles")
        defaults?.synchronize()
        call.resolve()
    }
}
