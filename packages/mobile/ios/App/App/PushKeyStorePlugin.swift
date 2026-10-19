import Capacitor
import Foundation

/// Minimal app-local plugin: reads and writes the push content key in the shared
/// keychain group. JS never sees a plugin object, only the wrapper in src/lib/push-key.ts.
@objc(PushKeyStorePlugin)
public class PushKeyStorePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "PushKeyStorePlugin"
    public let jsName = "PushKeyStore"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clear", returnType: CAPPluginReturnPromise),
    ]

    /// `key` is base64 of 32 random bytes.
    @objc func set(_ call: CAPPluginCall) {
        guard let b64 = call.getString("key"), let data = Data(base64Encoded: b64), data.count == 32 else {
            call.reject("key must be base64 of 32 bytes")
            return
        }
        let status = PushKeychain.write(data)
        if status == errSecSuccess { call.resolve() } else { call.reject("keychain write failed (\(status))") }
    }

    @objc func get(_ call: CAPPluginCall) {
        if let data = PushKeychain.read() {
            call.resolve(["key": data.base64EncodedString()])
        } else {
            call.resolve([:])
        }
    }

    @objc func clear(_ call: CAPPluginCall) {
        PushKeychain.delete()
        call.resolve()
    }
}
