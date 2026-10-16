/**
 * Where the token and the server address live on the Mac.
 *
 * The device token is a secret the server minted once, so it goes in the
 * Keychain when the Keychain accepts it. A locally built, unsigned app
 * occasionally cannot write Keychain items (locked keychain, no signing
 * identity) — in that case we fall back to a mode-600 file under Application
 * Support and say so in the UI, rather than losing the pairing silently.
 */
import Foundation
import Security

public struct ServerSettings: Sendable, Equatable, Codable {
  public var url: String
  public var deviceName: String
  /// Highest server frame seq this device has seen — persisted so a relaunch
  /// can `resync` and re-enter a turn that is still running on the server.
  public var lastSeq: Int

  public init(url: String, deviceName: String, lastSeq: Int = 0) {
    self.url = url
    self.deviceName = deviceName
    self.lastSeq = lastSeq
  }

  public static let local = ServerSettings(url: "ws://127.0.0.1:8787/ws", deviceName: Host.current().localizedName ?? "Mac", lastSeq: 0)

  public var websocketURL: URL? {
    let trimmed = url.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return nil }
    // Accept host[:port], http(s)://…, ws(s)://… — people type all four.
    var text = trimmed
    let typedScheme = text.contains("://")
    if !typedScheme { text = "ws://\(text)" }
    if text.hasPrefix("http://") { text = "ws://" + text.dropFirst("http://".count) }
    if text.hasPrefix("https://") { text = "wss://" + text.dropFirst("https://".count) }
    guard var components = URLComponents(string: text), let host = components.host, !host.isEmpty else { return nil }
    components.scheme = (components.scheme == "wss") ? "wss" : "ws"
    if components.path.isEmpty || components.path == "/" { components.path = "/ws" }
    // A bare host means the daemon's default port; a typed scheme keeps its
    // own, so a real wss:// endpoint is not dragged onto 8787.
    if !typedScheme, components.port == nil { components.port = 8787 }
    return components.url
  }

  public var healthURL: URL? {
    guard let websocketURL, var wsComponents = URLComponents(url: websocketURL, resolvingAgainstBaseURL: false) else { return nil }
    wsComponents.scheme = websocketURL.scheme == "wss" ? "https" : "http"
    wsComponents.path = "/health"
    wsComponents.query = nil
    return wsComponents.url
  }
}

public enum SecretStoreKind: String, Sendable {
  case keychain
  case file
}

public enum SecretStoreError: Error, CustomStringConvertible {
  case keychain(OSStatus)
  case file(String)

  public var description: String {
    switch self {
    case .keychain(let status): "keychain error \(status)"
    case .file(let detail): detail
    }
  }
}

/// Token storage. Keychain first; the file store is the honest fallback.
public enum SecretStore {
  private static let service = "dev.agni.mac"
  private static let account = "device-token"

  private static var supportDirectory: URL {
    let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
      ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")
    return base.appendingPathComponent("Agni", isDirectory: true)
  }

  private static var fileURL: URL { supportDirectory.appendingPathComponent("device-token") }

  public static func load() -> (token: String, kind: SecretStoreKind)? {
    if let token = keychainToken() { return (token, .keychain) }
    if let token = try? String(contentsOf: fileURL, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines),
      !token.isEmpty
    {
      return (token, .file)
    }
    return nil
  }

  @discardableResult
  public static func save(token: String) -> SecretStoreKind {
    let trimmed = token.trimmingCharacters(in: .whitespacesAndNewlines)
    if keychainSave(trimmed) {
      try? FileManager.default.removeItem(at: fileURL)
      return .keychain
    }
    try? FileManager.default.createDirectory(at: supportDirectory, withIntermediateDirectories: true)
    try? trimmed.write(to: fileURL, atomically: true, encoding: .utf8)
    try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: fileURL.path)
    return .file
  }

  public static func clear() {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
    SecItemDelete(query as CFDictionary)
    try? FileManager.default.removeItem(at: fileURL)
  }

  // MARK: keychain

  private static func keychainQuery(_ extra: [String: Any]) -> [String: Any] {
    var query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
    for (key, value) in extra { query[key] = value }
    return query
  }

  private static func keychainToken() -> String? {
    var item: CFTypeRef?
    let status = SecItemCopyMatching(
      keychainQuery([
        kSecReturnData as String: true,
        kSecMatchLimit as String: kSecMatchLimitOne,
      ]) as CFDictionary,
      &item
    )
    guard status == errSecSuccess, let data = item as? Data, let token = String(data: data, encoding: .utf8) else {
      return nil
    }
    return token.isEmpty ? nil : token
  }

  private static func keychainSave(_ token: String) -> Bool {
    let data = Data(token.utf8)
    let updateStatus = SecItemUpdate(
      keychainQuery([:]) as CFDictionary,
      [kSecValueData as String: data] as CFDictionary
    )
    if updateStatus == errSecSuccess { return true }
    let addStatus = SecItemAdd(
      keychainQuery([
        kSecValueData as String: data,
        kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
      ]) as CFDictionary,
      nil
    )
    return addStatus == errSecSuccess
  }
}

/// UserDefaults-backed, touched only from the main actor.
public struct SettingsStore {
  private let defaults: UserDefaults
  private let key = "dev.agni.mac.settings"

  public init(defaults: UserDefaults = .standard) {
    self.defaults = defaults
  }

  public func load() -> ServerSettings {
    guard let data = defaults.data(forKey: key),
      let settings = try? JSONDecoder().decode(ServerSettings.self, from: data)
    else { return .local }
    return settings
  }

  public func save(_ settings: ServerSettings) {
    guard let data = try? JSONEncoder().encode(settings) else { return }
    defaults.set(data, forKey: key)
  }
}
