import Foundation
import Security

/// The push content keys, in a keychain access group shared by the app and the
/// Notification Service Extension. The app writes one key per paired Mac when the
/// phone registers for push; the extension reads them to decrypt `enc` before the
/// notification is shown. Compiled into both targets.
///
/// Each key is stored under a short key id (`kid`, first 8 hex of sha256(hostId),
/// computed by the app and the bridge; opaque here). The push carries the kid next to
/// `enc` so the extension tries the right key first. The empty kid is the single key
/// written by builds that predated multiple Macs.
enum PushKeychain {
    private static let service = "com.xische.dorabotremote.pushkey"
    private static let legacyAccount = "push-content-key"
    private static let accountPrefix = "push-content-key."

    /// `$(AppIdentifierPrefix)com.xische.dorabotremote.shared`, expanded into Info.plist at build time.
    private static var group: String? {
        guard let g = Bundle.main.object(forInfoDictionaryKey: "DRKeychainGroup") as? String, !g.isEmpty, !g.contains("$(") else { return nil }
        return g
    }

    /// Unsigned builds (simulator CI, previews) carry no keychain-access-groups entitlement; fall back to the app's own keychain there.
    private static let missingEntitlement: OSStatus = -34018

    /// A kid is a short lowercase hex / url-safe token; anything else is refused so it cannot shape the account name.
    static func validKid(_ kid: String) -> Bool {
        if kid.isEmpty { return true }
        guard kid.count <= 16 else { return false }
        return kid.unicodeScalars.allSatisfy { ($0.value >= 48 && $0.value <= 57) || ($0.value >= 97 && $0.value <= 122) || ($0.value >= 65 && $0.value <= 90) || $0 == "-" || $0 == "_" }
    }

    private static func account(_ kid: String) -> String { kid.isEmpty ? legacyAccount : accountPrefix + kid }

    private static func baseQuery(account: String?, useGroup: Bool = true) -> [String: Any] {
        var q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
        ]
        if let a = account { q[kSecAttrAccount as String] = a }
        if useGroup, let g = group { q[kSecAttrAccessGroup as String] = g }
        return q
    }

    @discardableResult
    static func write(_ key: Data, kid: String) -> OSStatus {
        guard validKid(kid) else { return errSecParam }
        _ = delete(kid: kid)
        var q = baseQuery(account: account(kid))
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

    static func read(kid: String) -> Data? {
        guard validKid(kid) else { return nil }
        var q = baseQuery(account: account(kid))
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

    /// Every stored key with its kid ("" for the pre-multi-Mac key).
    static func readAll() -> [(kid: String, key: Data)] {
        var q = baseQuery(account: nil)
        q[kSecReturnData as String] = true
        q[kSecReturnAttributes as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitAll
        var out: AnyObject?
        var status = SecItemCopyMatching(q as CFDictionary, &out)
        if status == missingEntitlement {
            q.removeValue(forKey: kSecAttrAccessGroup as String)
            status = SecItemCopyMatching(q as CFDictionary, &out)
        }
        guard status == errSecSuccess, let rows = out as? [[String: Any]] else { return [] }
        return rows.compactMap { row in
            guard let account = row[kSecAttrAccount as String] as? String, let data = row[kSecValueData as String] as? Data else { return nil }
            if account == legacyAccount { return (kid: "", key: data) }
            guard account.hasPrefix(accountPrefix) else { return nil }
            return (kid: String(account.dropFirst(accountPrefix.count)), key: data)
        }
    }

    typealias Entry = (kid: String, key: Data)

    /// The key whose kid matches first, then every other stored key (older pushes carry no kid).
    static func candidates(kid: String?) -> [Entry] {
        let all = readAll().filter { $0.key.count == 32 }
        guard let kid = kid, !kid.isEmpty else { return all }
        return all.filter { $0.kid == kid } + all.filter { $0.kid != kid }
    }

    @discardableResult
    static func delete(kid: String) -> OSStatus {
        guard validKid(kid) else { return errSecParam }
        var status = SecItemDelete(baseQuery(account: account(kid)) as CFDictionary)
        if status == missingEntitlement { status = SecItemDelete(baseQuery(account: account(kid), useGroup: false) as CFDictionary) }
        return status
    }

    @discardableResult
    static func deleteAll() -> OSStatus {
        var status = SecItemDelete(baseQuery(account: nil) as CFDictionary)
        if status == missingEntitlement { status = SecItemDelete(baseQuery(account: nil, useGroup: false) as CFDictionary) }
        return status
    }
}
