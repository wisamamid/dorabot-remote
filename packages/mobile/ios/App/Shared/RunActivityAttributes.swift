import ActivityKit
import Foundation

/// Live Activity for a run that is active in the session the user has open.
/// The elapsed time is rendered by the system from `startedAt`, so the app does not have to tick.
@available(iOS 16.1, *)
struct RunActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        var status: String
        var startedAt: Date
    }

    var sessionName: String
}
