import Capacitor
import Foundation

/// Minimal app-local plugin: reads and writes the per-Mac push content keys in the shared
/// keychain group. JS never sees a plugin object, only the wrapper in src/lib/push-key.ts.
@objc(PushKeyStorePlugin)
public class PushKeyStorePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "PushKeyStorePlugin"
    public let jsName = "PushKeyStore"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "list", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clear", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearAll", returnType: CAPPluginReturnPromise),
    ]

    /// `kid` is the Mac's short key id ("" is the pre-multi-Mac key); `key` is base64 of 32 random bytes.
    @objc func set(_ call: CAPPluginCall) {
        guard let kid = call.getString("kid"), PushKeychain.validKid(kid) else {
            call.reject("invalid kid")
            return
        }
        guard let b64 = call.getString("key"), let data = Data(base64Encoded: b64), data.count == 32 else {
            call.reject("key must be base64 of 32 bytes")
            return
        }
        let status = PushKeychain.write(data, kid: kid)
        if status == errSecSuccess { call.resolve() } else { call.reject("keychain write failed (\(status))") }
    }

    @objc func get(_ call: CAPPluginCall) {
        if let kid = call.getString("kid"), let data = PushKeychain.read(kid: kid) {
            call.resolve(["key": data.base64EncodedString()])
        } else {
            call.resolve([:])
        }
    }

    @objc func list(_ call: CAPPluginCall) {
        let keys = PushKeychain.readAll().map { ["kid": $0.kid, "key": $0.key.base64EncodedString()] }
        call.resolve(["keys": keys])
    }

    @objc func clear(_ call: CAPPluginCall) {
        if let kid = call.getString("kid") { PushKeychain.delete(kid: kid) }
        call.resolve()
    }

    @objc func clearAll(_ call: CAPPluginCall) {
        PushKeychain.deleteAll()
        call.resolve()
    }
}
