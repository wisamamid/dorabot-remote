import SwiftUI

/// DoraBot Remote on the wrist: the pending approvals / questions from the phone, with Approve / Deny
/// for routine approvals. The watch holds no pairing keys and never talks to the Mac or the relay: it only
/// exchanges messages with the iPhone app over WatchConnectivity (see PhoneLink).
@main
struct DorabotWatchApp: App {
    @StateObject private var link = PhoneLink()

    var body: some Scene {
        WindowGroup {
            InboxView().environmentObject(link)
        }
    }
}
