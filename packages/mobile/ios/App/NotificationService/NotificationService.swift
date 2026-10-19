import CryptoKit
import UserNotifications

/// Swaps the generic notification text for the real, end-to-end encrypted content.
/// `enc` = base64(nonce[12] || ciphertext || tag[16]), ChaCha20-Poly1305 with the
/// 32-byte key the app stored in the shared keychain group. Any failure leaves the
/// generic text the relay sent.
class NotificationService: UNNotificationServiceExtension {
    private var contentHandler: ((UNNotificationContent) -> Void)?
    private var best: UNMutableNotificationContent?

    override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        self.contentHandler = contentHandler
        let content = (request.content.mutableCopy() as? UNMutableNotificationContent) ?? UNMutableNotificationContent()
        best = content
        if let enc = request.content.userInfo["enc"] as? String, let text = Self.decrypt(enc) {
            if let title = text["title"] as? String, !title.isEmpty { content.title = title }
            if let body = text["body"] as? String, !body.isEmpty { content.body = body }
        }
        contentHandler(content)
    }

    override func serviceExtensionTimeWillExpire() {
        if let handler = contentHandler, let best = best { handler(best) }
    }

    static func decrypt(_ enc: String) -> [String: Any]? {
        guard let keyData = PushKeychain.read(), keyData.count == 32,
              let combined = Data(base64Encoded: enc),
              let box = try? ChaChaPoly.SealedBox(combined: combined),
              let plain = try? ChaChaPoly.open(box, using: SymmetricKey(data: keyData)),
              let obj = try? JSONSerialization.jsonObject(with: plain) as? [String: Any]
        else { return nil }
        return obj
    }
}
