import SwiftUI

struct InboxView: View {
    @EnvironmentObject var link: PhoneLink

    var body: some View {
        NavigationStack {
            Group {
                if link.items.isEmpty {
                    VStack(spacing: 6) {
                        Image(systemName: "checkmark.circle").font(.title2)
                        Text("Nothing waiting").font(.headline)
                        Text("Approvals and questions from your Mac show up here.")
                            .font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
                    }
                } else {
                    List(link.items) { item in
                        NavigationLink(value: item) { Row(item: item) }
                    }
                }
            }
            .navigationTitle("Inbox")
            .navigationDestination(for: WatchItem.self) { DetailView(item: $0) }
            .overlay(alignment: .bottom) {
                if let s = link.status {
                    Text(s).font(.footnote).padding(6).background(.regularMaterial, in: Capsule())
                        .onTapGesture { link.status = nil }
                }
            }
        }
        .onAppear { link.refresh() }
    }
}

private struct Row: View {
    let item: WatchItem
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text(item.title).font(.headline).lineLimit(1)
                if item.risky { Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.red) }
            }
            Text(item.sessionName).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
            if !item.summary.isEmpty { Text(item.summary).font(.footnote).lineLimit(2) }
        }
    }
}

struct DetailView: View {
    let item: WatchItem
    @EnvironmentObject var link: PhoneLink
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    /// True while the wrist is down and the display is dimmed.
    @Environment(\.isLuminanceReduced) private var dimmed

    /// watchOS has no public API to ask "is the watch on a wrist and unlocked". The OS locks the watch when it
    /// is taken off (wrist detection + passcode) and only a visible, active app can be tapped, so the app
    /// additionally refuses to act unless it is active and not dimmed, and the snapshot is fresh.
    private var canAct: Bool { scenePhase == .active && !dimmed && !link.busy && !link.isStale }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 6) {
                Text(item.hostName).font(.caption2).foregroundStyle(.secondary)
                Text(item.sessionName).font(.caption).foregroundStyle(.secondary)
                Text(item.title).font(.headline)
                if !item.summary.isEmpty { Text(item.summary).font(.footnote) }
                actions
            }
        }
    }

    @ViewBuilder private var actions: some View {
        if item.kind == "question" {
            Label("Answer on iPhone", systemImage: "iphone").font(.footnote).padding(.top, 6)
        } else if item.risky {
            Label("Open on iPhone to approve", systemImage: "faceid").font(.footnote).foregroundStyle(.red).padding(.top, 6)
        } else {
            Button("Approve") { link.send("approve", rid: item.rid); dismiss() }
                .tint(.green).disabled(!canAct)
            Button("Deny", role: .destructive) { link.send("deny", rid: item.rid); dismiss() }
                .disabled(!canAct)
            if link.isStale { Text("Out of date. Reopen to refresh.").font(.caption2).foregroundStyle(.secondary) }
        }
    }
}
