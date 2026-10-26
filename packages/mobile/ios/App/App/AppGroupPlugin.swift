import ActivityKit
import Capacitor
import Foundation
import UIKit
import WidgetKit

/// App-local plugin: the App Group hand-offs. JS never sees a plugin object, only the wrapper in src/lib/appgroup.ts.
///  - takeShare: read and delete what the Share Extension left (text + photos).
///  - writeSnapshot / reloadWidgets: feed the home-screen widget.
///  - startRun / updateRun / endRun: the Live Activity for an active run.
@objc(AppGroupPlugin)
public class AppGroupPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AppGroupPlugin"
    public let jsName = "AppGroup"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "takeShare", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "writeSnapshot", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "reloadWidgets", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startRun", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "updateRun", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "endRun", returnType: CAPPluginReturnPromise),
    ]

    // MARK: Share hand-off

    /// `id` optional: with none, the newest pending share is taken. Entries older than a day are discarded.
    @objc func takeShare(_ call: CAPPluginCall) {
        DispatchQueue.global(qos: .userInitiated).async {
            guard let root = AppGroup.shareRoot else { return call.resolve(["found": false]) }
            let fm = FileManager.default
            let dirs = (try? fm.contentsOfDirectory(at: root, includingPropertiesForKeys: [.contentModificationDateKey])) ?? []
            for d in dirs {
                let m = (try? d.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantPast
                if Date().timeIntervalSince(m) > 86_400 { try? fm.removeItem(at: d) }
            }
            var target: URL?
            if let id = call.getString("id") {
                guard id.range(of: "^[A-Za-z0-9-]{1,64}$", options: .regularExpression) != nil else { return call.resolve(["found": false]) }
                target = root.appendingPathComponent(id, isDirectory: true)
            } else {
                target = ((try? fm.contentsOfDirectory(at: root, includingPropertiesForKeys: [.contentModificationDateKey])) ?? [])
                    .max { a, b in
                        let da = (try? a.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantPast
                        let db = (try? b.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantPast
                        return da < db
                    }
            }
            guard let dir = target, let data = try? Data(contentsOf: dir.appendingPathComponent("payload.json")),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                return call.resolve(["found": false])
            }
            var images: [[String: String]] = []
            for name in (obj["images"] as? [String]) ?? [] where name.range(of: "^image-[0-9]{1,2}\\.jpg$", options: .regularExpression) != nil {
                if let bytes = try? Data(contentsOf: dir.appendingPathComponent(name)) {
                    images.append(["data": bytes.base64EncodedString(), "mediaType": "image/jpeg"])
                }
            }
            try? fm.removeItem(at: dir)
            call.resolve([
                "found": true,
                "id": dir.lastPathComponent,
                "text": (obj["text"] as? String) ?? "",
                "images": images,
            ])
        }
    }

    // MARK: Widget

    @objc func writeSnapshot(_ call: CAPPluginCall) {
        guard let url = AppGroup.snapshotURL else { return call.reject("App Group unavailable") }
        let snap = WidgetSnapshot(
            hostName: String((call.getString("hostName") ?? "").prefix(80)),
            pending: max(0, min(call.getInt("pending") ?? 0, 999)),
            updatedAt: Date().timeIntervalSince1970
        )
        do {
            try JSONEncoder().encode(snap).write(to: url, options: .atomic)
            call.resolve()
        } catch {
            call.reject("snapshot write failed")
        }
    }

    @objc func reloadWidgets(_ call: CAPPluginCall) {
        if #available(iOS 14.0, *) { WidgetCenter.shared.reloadAllTimelines() }
        call.resolve()
    }

    // MARK: Live Activity

    @objc func startRun(_ call: CAPPluginCall) {
        guard #available(iOS 16.2, *) else { return call.resolve(["started": false]) }
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return call.resolve(["started": false]) }
        let name = String((call.getString("sessionName") ?? "Session").prefix(80))
        let status = call.getString("status") ?? "Working"
        let started = Date(timeIntervalSince1970: (call.getDouble("startedAt") ?? Date().timeIntervalSince1970 * 1000) / 1000)
        Task {
            for a in Activity<RunActivityAttributes>.activities { await a.end(nil, dismissalPolicy: .immediate) }
            let state = RunActivityAttributes.ContentState(status: status, startedAt: started)
            do {
                _ = try Activity.request(
                    attributes: RunActivityAttributes(sessionName: name),
                    content: .init(state: state, staleDate: nil),
                    pushType: nil
                )
                call.resolve(["started": true])
            } catch {
                call.resolve(["started": false])
            }
        }
    }

    @objc func updateRun(_ call: CAPPluginCall) {
        guard #available(iOS 16.2, *) else { return call.resolve() }
        let status = call.getString("status") ?? "Working"
        Task {
            for a in Activity<RunActivityAttributes>.activities {
                let state = RunActivityAttributes.ContentState(status: status, startedAt: a.content.state.startedAt)
                await a.update(.init(state: state, staleDate: nil))
            }
            call.resolve()
        }
    }

    @objc func endRun(_ call: CAPPluginCall) {
        guard #available(iOS 16.2, *) else { return call.resolve() }
        Task {
            for a in Activity<RunActivityAttributes>.activities {
                await a.end(a.content, dismissalPolicy: .immediate)
            }
            call.resolve()
        }
    }
}
