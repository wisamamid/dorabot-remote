import Capacitor
import Foundation
import WatchConnectivity

/// App-local plugin: the phone's end of the Apple Watch link. JS never sees a plugin object, only the
/// wrapper in src/lib/watch.ts.
///  - sendSnapshot: pushes the inbox list to the watch (application context: latest value wins, delivered
///    even if the watch app is not running).
///  - the watch's approve / deny / refresh requests arrive as `watchRequest` events; JS answers with `reply`.
///    If JS does not answer in time (app suspended, not paired to a Mac) the watch is told so, and nothing is done.
/// The watch never holds keys and never talks to the Mac: this is its only way to act.
@objc(WatchBridgePlugin)
public class WatchBridgePlugin: CAPPlugin, CAPBridgedPlugin, WCSessionDelegate {
    public let identifier = "WatchBridgePlugin"
    public let jsName = "WatchBridge"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "sendSnapshot", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "reply", returnType: CAPPluginReturnPromise),
    ]

    private static let replyTimeout: TimeInterval = 8
    private var waiting: [String: ([String: Any]) -> Void] = [:]
    private var lastSnapshot: String = ""

    override public func load() {
        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
    }

    // MARK: JS -> watch

    @objc func sendSnapshot(_ call: CAPPluginCall) {
        guard let json = call.getString("json"), json.utf8.count < 60_000 else { return call.reject("bad snapshot") }
        DispatchQueue.main.async {
            self.lastSnapshot = json
            self.pushSnapshot()
            call.resolve()
        }
    }

    private func pushSnapshot() {
        guard WCSession.isSupported() else { return }
        let s = WCSession.default
        guard s.activationState == .activated, s.isPaired, s.isWatchAppInstalled, !lastSnapshot.isEmpty else { return }
        try? s.updateApplicationContext(["snapshot": lastSnapshot, "sent": Date().timeIntervalSince1970])
    }

    @objc func reply(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else { return call.reject("missing id") }
        let payload: [String: Any] = ["ok": call.getBool("ok") ?? false, "message": call.getString("message") ?? ""]
        DispatchQueue.main.async {
            self.waiting.removeValue(forKey: id)?(payload)
            call.resolve()
        }
    }

    // MARK: watch -> JS

    public func session(_ session: WCSession, didReceiveMessage message: [String: Any], replyHandler: @escaping ([String: Any]) -> Void) {
        let fail = { (m: String) in replyHandler(["ok": false, "message": m]) }
        guard let action = message["action"] as? String, ["approve", "deny", "refresh"].contains(action) else { return fail("Unsupported") }
        let rid = message["rid"] as? String
        if action != "refresh" && (rid == nil || rid!.isEmpty || rid!.count > 200) { return fail("Unsupported") }
        let id = UUID().uuidString
        DispatchQueue.main.async {
            self.waiting[id] = replyHandler
            var data: [String: Any] = ["id": id, "action": action]
            if let rid = rid { data["rid"] = rid }
            self.notifyListeners("watchRequest", data: data)
            DispatchQueue.main.asyncAfter(deadline: .now() + Self.replyTimeout) {
                self.waiting.removeValue(forKey: id)?(["ok": false, "message": "Phone not connected"])
            }
        }
        if action == "refresh" { DispatchQueue.main.async { self.pushSnapshot() } }
    }

    public func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        DispatchQueue.main.async { self.pushSnapshot() }
    }

    public func sessionDidBecomeInactive(_ session: WCSession) {}

    public func sessionDidDeactivate(_ session: WCSession) {
        WCSession.default.activate()
    }

    public func sessionWatchStateDidChange(_ session: WCSession) {
        DispatchQueue.main.async { self.pushSnapshot() }
    }
}
