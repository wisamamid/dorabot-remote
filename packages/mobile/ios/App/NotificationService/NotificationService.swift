import CryptoKit
import UserNotifications

/// Swaps the generic notification text for the real, end-to-end encrypted content.
/// `enc` = base64(nonce[12] || ciphertext || tag[16]), ChaCha20-Poly1305 with a 32-byte
/// key the app stored in the shared keychain group, one per paired Mac. The unencrypted
/// `kid` next to `enc` names the key to try first; with no kid (or no match) every stored
/// key is tried. Any failure leaves the generic text the relay sent.
class NotificationService: UNNotificationServiceExtension {
    private var contentHandler: ((UNNotificationContent) -> Void)?
    private var best: UNMutableNotificationContent?

    override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        self.contentHandler = contentHandler
        let content = (request.content.mutableCopy() as? UNMutableNotificationContent) ?? UNMutableNotificationContent()
        best = content
        let info = request.content.userInfo
        // Approve / Deny buttons are only offered when the content decrypts with a stored key and says
        // it is an approval. The plaintext category comes from the relay and is not trusted, so strip it
        // first and restore it only after a successful decrypt (this also covers the expiry path).
        let offeredCategory = content.categoryIdentifier
        if offeredCategory == "APPROVAL" { content.categoryIdentifier = "ACTIVITY" }
        if let enc = info["enc"] as? String {
            let keys = PushKeychain.candidates(kid: info["kid"] as? String)
            if let text = Self.decrypt(enc, keys: keys) {
                if offeredCategory == "APPROVAL", (text["kind"] as? String) == "approval" { content.categoryIdentifier = "APPROVAL" }
                if let title = text["title"] as? String, !title.isEmpty { content.title = title }
                if let body = text["body"] as? String, !body.isEmpty { content.body = body }
                // With more than one Mac paired, say which one this is from.
                if keys.count > 1, let host = text["hostName"] as? String, !host.isEmpty { content.subtitle = host }
            }
        }
        contentHandler(content)
    }

    override func serviceExtensionTimeWillExpire() {
        if let handler = contentHandler, let best = best { handler(best) }
    }

    static func decrypt(_ enc: String, keys: [Data]) -> [String: Any]? {
        guard let combined = Data(base64Encoded: enc), let box = try? ChaChaPoly.SealedBox(combined: combined) else { return nil }
        for keyData in keys where keyData.count == 32 {
            if let plain = try? ChaChaPoly.open(box, using: SymmetricKey(data: keyData)),
               let obj = try? JSONSerialization.jsonObject(with: plain) as? [String: Any] {
                return obj
            }
        }
        return nil
    }
}
