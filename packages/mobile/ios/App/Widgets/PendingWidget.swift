import SwiftUI
import WidgetKit

/// Home-screen widget: how many approvals / questions are waiting, and which Mac. Data comes from the
/// snapshot the app writes into the App Group on inbox / connection changes.
struct PendingEntry: TimelineEntry {
    let date: Date
    let hostName: String
    let pending: Int
    let hasData: Bool
}

struct PendingProvider: TimelineProvider {
    func placeholder(in context: Context) -> PendingEntry {
        PendingEntry(date: Date(), hostName: "Your Mac", pending: 2, hasData: true)
    }

    func getSnapshot(in context: Context, completion: @escaping (PendingEntry) -> Void) {
        completion(entry())
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<PendingEntry>) -> Void) {
        // The app reloads timelines when something changes; this is only a slow safety refresh.
        completion(Timeline(entries: [entry()], policy: .after(Date().addingTimeInterval(30 * 60))))
    }

    private func entry() -> PendingEntry {
        if let s = WidgetSnapshot.read() {
            return PendingEntry(date: Date(), hostName: s.hostName, pending: s.pending, hasData: true)
        }
        return PendingEntry(date: Date(), hostName: "", pending: 0, hasData: false)
    }
}

struct PendingView: View {
    let entry: PendingEntry

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("dorabot")
                .font(.caption.weight(.semibold))
                .foregroundColor(.secondary)
            if entry.hasData {
                Text("\(entry.pending)")
                    .font(.system(size: 44, weight: .bold, design: .rounded))
                    .foregroundColor(entry.pending > 0 ? .orange : .primary)
                Text(entry.pending == 1 ? "needs you" : "need you")
                    .font(.footnote)
                if !entry.hostName.isEmpty {
                    Text(entry.hostName)
                        .font(.caption2)
                        .foregroundColor(.secondary)
                        .lineLimit(1)
                }
            } else {
                Text("Open dorabot to connect")
                    .font(.footnote)
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .padding(12)
        .widgetBackground()
        .widgetURL(URL(string: "dorabot-remote://inbox"))
    }
}

extension View {
    @ViewBuilder func widgetBackground() -> some View {
        if #available(iOS 17.0, *) {
            self.containerBackground(.fill.tertiary, for: .widget)
        } else {
            self.background(Color(UIColor.secondarySystemBackground))
        }
    }
}

struct PendingWidget: Widget {
    let kind = "PendingWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: PendingProvider()) { entry in
            PendingView(entry: entry)
        }
        .configurationDisplayName("Needs you")
        .description("Approvals and questions waiting on you, and which Mac.")
        .supportedFamilies([.systemSmall])
    }
}
