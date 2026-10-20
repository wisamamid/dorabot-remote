import AppIntents
import UIKit

/// Siri / Shortcuts entry points. Each intent opens the app and hands the request to the web
/// layer through the app's own URL scheme (`dorabot-remote://ask?...`, `dorabot-remote://inbox`),
/// which the app validates, gates behind Face ID if the app lock is on, and queues until the
/// right Mac is connected (src/lib/applink.ts). Nothing here talks to a Mac or reads a secret.
/// AppIntents is iOS 16+; the app's minimum is 15, so everything is availability-guarded
/// (and the framework is weak-linked, see OTHER_LDFLAGS).

enum DorabotLink {
    /// Strict encoding: everything but unreserved characters, so '+' and '&' in a prompt survive.
    private static let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")

    private static func enc(_ s: String) -> String { s.addingPercentEncoding(withAllowedCharacters: allowed) ?? "" }

    /// `n` is a one-off id so the app can ignore a replay of the same launch URL.
    static func url(target: String, query: [(String, String)]) -> URL? {
        let items = query.filter { !$0.1.isEmpty } + [("n", UUID().uuidString)]
        let q = items.map { "\($0.0)=\(enc($0.1))" }.joined(separator: "&")
        return URL(string: "dorabot-remote://\(target)?\(q)")
    }

    static func ask(prompt: String, host: String?) -> URL? {
        let p = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !p.isEmpty else { return nil }
        return url(target: "ask", query: [("prompt", p), ("host", (host ?? "").trimmingCharacters(in: .whitespacesAndNewlines))])
    }

    static func inbox() -> URL? { url(target: "inbox", query: []) }
}

@available(iOS 16.0, *)
struct DorabotIntentError: Error, CustomLocalizedStringResourceConvertible {
    let message: String
    var localizedStringResource: LocalizedStringResource { LocalizedStringResource(stringLiteral: message) }
}

@available(iOS 16.0, *)
struct AskDorabotIntent: AppIntent {
    static var title: LocalizedStringResource = "Ask dorabot"
    static var description = IntentDescription("Start a new dorabot session on your computer with a prompt.")
    static var openAppWhenRun: Bool = true

    @Parameter(title: "Prompt", requestValueDialog: "What should dorabot do?")
    var prompt: String

    @Parameter(title: "Computer", description: "The name of a paired computer. Leave empty to use the active computer.")
    var mac: String?

    static var parameterSummary: some ParameterSummary {
        Summary("Ask dorabot \(\.$prompt)") {
            \.$mac
        }
    }

    @MainActor
    func perform() async throws -> some IntentResult {
        guard let url = DorabotLink.ask(prompt: prompt, host: mac) else {
            throw DorabotIntentError(message: "Tell dorabot what to do.")
        }
        await UIApplication.shared.open(url)
        return .result()
    }
}

@available(iOS 16.0, *)
struct OpenDorabotInboxIntent: AppIntent {
    static var title: LocalizedStringResource = "Open dorabot Inbox"
    static var description = IntentDescription("Open the Inbox of approvals and questions waiting for you.")
    static var openAppWhenRun: Bool = true

    @MainActor
    func perform() async throws -> some IntentResult {
        if let url = DorabotLink.inbox() { await UIApplication.shared.open(url) }
        return .result()
    }
}

@available(iOS 16.0, *)
struct DorabotShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: AskDorabotIntent(),
            phrases: [
                "Ask \(.applicationName)",
                "New dorabot session in \(.applicationName)",
                "Start a session in \(.applicationName)",
            ],
            shortTitle: "Ask dorabot",
            systemImageName: "bubble.left.and.text.bubble.right"
        )
        AppShortcut(
            intent: OpenDorabotInboxIntent(),
            phrases: [
                "Open \(.applicationName) Inbox",
                "Open the Inbox in \(.applicationName)",
            ],
            shortTitle: "Open Inbox",
            systemImageName: "tray"
        )
    }
}
