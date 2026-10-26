import ActivityKit
import SwiftUI
import WidgetKit

/// Live Activity shown while a run is active in the session the user has open.
@available(iOS 16.2, *)
struct RunLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: RunActivityAttributes.self) { context in
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(context.attributes.sessionName).font(.headline).lineLimit(1)
                    Text(context.state.status).font(.subheadline).foregroundColor(.secondary).lineLimit(1)
                }
                Spacer()
                Text(timerInterval: context.state.startedAt...Date.distantFuture, countsDown: false)
                    .font(.system(.title3, design: .monospaced))
                    .multilineTextAlignment(.trailing)
                    .frame(width: 80, alignment: .trailing)
            }
            .padding(14)
            .activityBackgroundTint(Color(UIColor.secondarySystemBackground))
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Text(context.attributes.sessionName).font(.headline).lineLimit(1)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Text(timerInterval: context.state.startedAt...Date.distantFuture, countsDown: false)
                        .monospacedDigit().frame(width: 64, alignment: .trailing)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    Text(context.state.status).font(.subheadline).foregroundColor(.secondary)
                }
            } compactLeading: {
                Image(systemName: "bolt.fill")
            } compactTrailing: {
                Text(timerInterval: context.state.startedAt...Date.distantFuture, countsDown: false)
                    .monospacedDigit().frame(width: 44)
            } minimal: {
                Image(systemName: "bolt.fill")
            }
        }
    }
}
