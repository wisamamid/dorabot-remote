import Foundation

/// The App Group container shared by the app, the Share Extension and the Widgets extension.
/// Nothing secret goes in here: shared text/photos the user chose to send, and a tiny
/// widget snapshot (counts and a Mac name). Keys stay in the keychain group.
enum AppGroup {
    static let id = "group.com.xische.dorabotremote"

    static var containerURL: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: id)
    }

    /// share/<id>/payload.json (+ image-N.jpg), written by the Share Extension, consumed once by the app.
    static var shareRoot: URL? { containerURL?.appendingPathComponent("share", isDirectory: true) }

    /// Widget snapshot written by the app.
    static var snapshotURL: URL? { containerURL?.appendingPathComponent("widget-snapshot.json") }
}

/// What the home-screen widget shows. Written by the app on inbox / connection changes.
struct WidgetSnapshot: Codable {
    var hostName: String
    var pending: Int
    var updatedAt: Double

    static func read() -> WidgetSnapshot? {
        guard let url = AppGroup.snapshotURL, let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(WidgetSnapshot.self, from: data)
    }
}
