import SwiftUI
import WidgetKit

@main
struct DorabotWidgets: WidgetBundle {
    var body: some Widget {
        PendingWidget()
        if #available(iOS 16.2, *) {
            RunLiveActivity()
        }
    }
}
