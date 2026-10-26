import Foundation
import SwiftUI
import WatchConnectivity

/// One row of the phone's snapshot. Mirrors WatchItem in packages/mobile/src/lib/watch-logic.ts.
struct WatchItem: Codable, Identifiable, Hashable {
    let rid: String
    let kind: String
    let hostName: String
    let sessionName: String
    let title: String
    let summary: String
    let risky: Bool
    var id: String { rid }
}

private struct Snapshot: Codable {
    let items: [WatchItem]
    let at: Double
}

/// The watch's only link to anything: the paired iPhone. It can ask the phone to approve or deny a routine
/// request; the phone re-checks everything and refuses risky ones (they need Face ID on the phone).
final class PhoneLink: NSObject, ObservableObject, WCSessionDelegate {
    @Published var items: [WatchItem] = []
    @Published var snapshotAt: Date?
    @Published var status: String?
    @Published var busy = false

    override init() {
        super.init()
        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
    }

    /// A snapshot older than this is not acted on: the phone may have lost the Mac since.
    static let staleAfter: TimeInterval = 5 * 60

    var isStale: Bool {
        guard let at = snapshotAt else { return true }
        return Date().timeIntervalSince(at) > Self.staleAfter
    }

    func send(_ action: String, rid: String?) {
        guard WCSession.default.activationState == .activated, WCSession.default.isReachable else {
            status = "Phone not reachable"
            return
        }
        var msg: [String: Any] = ["action": action]
        if let rid = rid { msg["rid"] = rid }
        busy = true
        WCSession.default.sendMessage(msg, replyHandler: { reply in
            DispatchQueue.main.async {
                self.busy = false
                let ok = reply["ok"] as? Bool ?? false
                let message = reply["message"] as? String ?? ""
                self.status = message.isEmpty ? (ok ? "Done" : "Failed") : message
                if ok, let rid = rid { self.items.removeAll { $0.rid == rid } }
            }
        }, errorHandler: { _ in
            DispatchQueue.main.async {
                self.busy = false
                self.status = "Phone not reachable"
            }
        })
    }

    func refresh() { send("refresh", rid: nil) }

    private func apply(_ context: [String: Any]) {
        guard let json = context["snapshot"] as? String,
              let snap = try? JSONDecoder().decode(Snapshot.self, from: Data(json.utf8)) else { return }
        DispatchQueue.main.async {
            self.items = snap.items
            self.snapshotAt = Date(timeIntervalSince1970: snap.at / 1000)
        }
    }

    // MARK: WCSessionDelegate

    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        apply(session.receivedApplicationContext)
    }

    func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        apply(applicationContext)
    }
}
