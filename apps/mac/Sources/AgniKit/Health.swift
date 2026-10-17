/**
 * `GET /health` — the daemon's own snapshot: protocol version, uptime, provider
 * health, today's usage. The Mac app reads it for the inspector and the status
 * strip, and treats a failure as "server unreachable", not as a fatal error.
 */
import Foundation

public struct HealthReport: Sendable, Equatable, Decodable {
  public var ok: Bool
  public var v: Int
  public var serverTime: String
  public var uptimeMs: Int
  public var seq: Int
  public var providers: [ProviderStatus]
  public var usageToday: DayTotals
}

public struct ProviderStatus: Sendable, Equatable, Decodable, Identifiable {
  public var id: String
  public var label: String
  public var model: String
  /// Server snapshot doesn't carry tiers in v2 — absent means unspecified.
  public var tiers: [String]
  public var available: Bool
  public var cooldownRemainingMs: Int
  public var lastError: String?
  public var lastSuccessAt: Double?

  public init(
    id: String,
    label: String,
    model: String,
    tiers: [String],
    available: Bool,
    cooldownRemainingMs: Int,
    lastError: String? = nil,
    lastSuccessAt: Double? = nil
  ) {
    self.id = id
    self.label = label
    self.model = model
    self.tiers = tiers
    self.available = available
    self.cooldownRemainingMs = cooldownRemainingMs
    self.lastError = lastError
    self.lastSuccessAt = lastSuccessAt
  }

  private enum CodingKeys: String, CodingKey {
    case id, label, model, tiers, available, cooldownRemainingMs, lastError, lastSuccessAt
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    id = try container.decode(String.self, forKey: .id)
    label = try container.decode(String.self, forKey: .label)
    model = try container.decode(String.self, forKey: .model)
    tiers = try container.decodeIfPresent([String].self, forKey: .tiers) ?? []
    available = try container.decode(Bool.self, forKey: .available)
    cooldownRemainingMs = try container.decode(Int.self, forKey: .cooldownRemainingMs)
    lastError = try container.decodeIfPresent(String.self, forKey: .lastError)
    lastSuccessAt = try container.decodeIfPresent(Double.self, forKey: .lastSuccessAt)
  }
}

public struct DayTotals: Sendable, Equatable, Decodable {
  public var turns: Int
  public var inputTokens: Int
  public var outputTokens: Int
}

public enum HealthClient {
  public static func fetch(url: URL, session: URLSession = .shared) async throws -> HealthReport {
    var request = URLRequest(url: url)
    request.timeoutInterval = 6
    request.cachePolicy = .reloadIgnoringLocalCacheData
    let (data, response) = try await session.data(for: request)
    if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
      throw TransportError.failed("health returned HTTP \(http.statusCode)")
    }
    return try JSONDecoder().decode(HealthReport.self, from: data)
  }
}
