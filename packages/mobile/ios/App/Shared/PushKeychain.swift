import Foundation
import Security

/// The push content key, in a keychain access group shared by the app and the
/// Notification Service Extension. The app writes it when the phone registers
/// for push; the extension reads it to decrypt `enc` before the notification is
/// shown. Compiled into both targets.
enum PushKeychain {
    private static let service = "com.xische.dorabotremote.pushkey"
    private static let account = "push-content-key"

    /// `$(AppIdentifierPrefix)com.xische.dorabotremote.shared`, expanded into Info.plist at build time.
    private static var group: String? {
        guard let g = Bundle.main.object(forInfoDictionaryKey: "DRKeychainGroup") as? String, !g.isEmpty, !g.contains("$(") else { return nil }
        return g
    }

    /// Unsigned builds (simulator CI, previews) carry no keychain-access-groups entitlement; fall back to the app's own keychain there.
    private static let missingEntitlement: OSStatus = -34018

    private static func baseQuery(useGroup: Bool = true) -> [String: Any] {
        var q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        if useGroup, let g = group { q[kSecAttrAccessGroup as String] = g }
        return q
    }

    @discardableResult
    static func write(_ key: Data) -> OSStatus {
        _ = delete()
        var q = baseQuery()
        q[kSecValueData as String] = key
        // The extension runs while the phone is locked; first-unlock is the strictest class that allows it.
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(q as CFDictionary, nil)
        if status == missingEntitlement {
            q.removeValue(forKey: kSecAttrAccessGroup as String)
            return SecItemAdd(q as CFDictionary, nil)
        }
        return status
    }

    static func read() -> Data? {
        var q = baseQuery()
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: AnyObject?
        var status = SecItemCopyMatching(q as CFDictionary, &out)
        if status == missingEntitlement {
            q.removeValue(forKey: kSecAttrAccessGroup as String)
            status = SecItemCopyMatching(q as CFDictionary, &out)
        }
        guard status == errSecSuccess else { return nil }
        return out as? Data
    }

    @discardableResult
    static func delete() -> OSStatus {
        var status = SecItemDelete(baseQuery() as CFDictionary)
        if status == missingEntitlement { status = SecItemDelete(baseQuery(useGroup: false) as CFDictionary) }
        return status
    }
}
