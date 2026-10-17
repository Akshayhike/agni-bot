/**
 * Agni wire protocol v2 in Swift — the client half of the contract defined in
 * `packages/protocol/src/frames.ts`.
 *
 * Rules that keep the two languages honest:
 *   - Field names are the wire names; no renaming on the way in.
 *   - Unknown *frame types* decode to `.unknown` (the server may add frames);
 *     a known frame with a malformed payload fails loudly instead of guessing.
 *   - Unknown enum values (a new stop reason, a new decision) degrade to an
 *     `.other` case so a server addition never bricks the app.
 *   - `packages/protocol/fixtures/frames.json` is decoded by our tests: drift
 *     between TS and Swift fails `swift test`, not the user.
 */
import Foundation

public let PROTOCOL_VERSION = 2

// MARK: - shared value types

public enum StopReason: Sendable, Equatable {
  case end, cancelled, error, timeout, budget, other(String)

  public init(wire: String) {
    switch wire {
    case "end": self = .end
    case "cancelled": self = .cancelled
    case "error": self = .error
    case "timeout": self = .timeout
    case "budget": self = .budget
    default: self = .other(wire)
    }
  }

  public var wire: String {
    switch self {
    case .end: "end"
    case .cancelled: "cancelled"
    case .error: "error"
    case .timeout: "timeout"
    case .budget: "budget"
    case .other(let raw): raw
    }
  }

  /// What a person sees under the reply, or nil when the turn ended cleanly.
  public var explanation: String? {
    switch self {
    case .end: nil
    case .cancelled: "Stopped"
    case .error: "Failed"
    case .timeout: "Timed out"
    case .budget: "Out of budget"
    case .other(let raw): raw
    }
  }
}

public enum Decision: Sendable, Equatable, Hashable {
  case once, always, reject, other(String)

  public init(wire: String) {
    switch wire {
    case "once": self = .once
    case "always": self = .always
    case "reject": self = .reject
    default: self = .other(wire)
    }
  }

  public var wire: String {
    switch self {
    case .once: "once"
    case .always: "always"
    case .reject: "reject"
    case .other(let raw): raw
    }
  }

  /// Button title. Sentence case, says exactly what happens.
  public var title: String {
    switch self {
    case .once: "Allow once"
    case .always: "Always allow"
    case .reject: "Reject"
    case .other(let raw): raw
    }
  }
}

public struct Usage: Sendable, Equatable, Decodable {
  public var provider: String?
  public var model: String?
  public var inputTokens: Int?
  public var outputTokens: Int?
  public var latencyMs: Int?
}

public struct AgentInfo: Sendable, Equatable, Decodable, Identifiable {
  public var id: String
  public var name: String
  public var color: String?
  public var model: String?
  public var tools: [String]?

  public init(id: String, name: String, color: String? = nil, model: String? = nil, tools: [String]? = nil) {
    self.id = id
    self.name = name
    self.color = color
    self.model = model
    self.tools = tools
  }

  /// `#f0b95a` → a colour the UI can use, with a neutral fallback.
  public var colorHex: String { color ?? "#9A9AA0" }
}

public struct ThreadInfo: Sendable, Equatable, Decodable, Identifiable {
  public var id: String
  public var agentID: String
  public var title: String?
  public var updatedAt: String
  /// Last message, one line — optional so an older server still decodes.
  public var preview: String?
}

public struct MessageInfo: Sendable, Equatable, Decodable {
  public var id: String
  public var role: String
  public var text: String
  public var createdAt: String
  public var turnID: String?
  /// Session block the message belongs to (conversation model, v2).
  public var sessionID: String?
}

public struct JobInfo: Sendable, Equatable, Decodable, Identifiable {
  public var id: String
  public var kind: String
  public var state: String
  public var runAt: String
  public var enabled: Bool
  public var attempts: Int
  /// Recurrence in milliseconds; nil for one-shot work.
  public var everyMs: Int?
  /// The prompt this routine runs, already trimmed for display.
  public var title: String?
  public var threadID: String?
  public var lastResult: String?
}

public struct TaskInfo: Sendable, Equatable, Decodable, Identifiable {
  public var id: String
  public var title: String
  public var dueAt: String?
  public var priority: String
  public var status: String
  public var snoozedUntil: String?
  public var createdAt: String
  public var updatedAt: String
}

public struct ProviderInfo: Sendable, Equatable, Decodable, Identifiable {
  public var id: String
  public var label: String
  public var model: String
  /// The wire omits tiers in v2 — absent means unspecified.
  public var tiers: [String]
  public var available: Bool
  public var cooldownRemainingMs: Double
  public var lastError: String?
  public var lastSuccessAt: Double?

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
    cooldownRemainingMs = try container.decode(Double.self, forKey: .cooldownRemainingMs)
    lastError = try container.decodeIfPresent(String.self, forKey: .lastError)
    lastSuccessAt = try container.decodeIfPresent(Double.self, forKey: .lastSuccessAt)
  }
}

// MARK: - client → server

public enum ClientFrame: Sendable, Equatable {
  case hello(v: Int, token: String, device: String)
  case resync(lastSeq: Int)
  case msgSend(threadID: String?, text: String, files: [String]?, conversationID: String?)
  case msgCancel(turnID: String)
  case approveReply(requestID: String, decision: Decision)
  case agentSelect(agentID: String)
  case conversationOpen(conversationID: String, agentID: String?)
  case sessionNew(conversationID: String)
  case conversationHistory(conversationID: String, limit: Int?)
  case threadOpen(threadID: String)
  case threadList(limit: Int?)
  case threadHistory(threadID: String, limit: Int?)
  case jobList(limit: Int?)
  case jobSet(jobID: String, action: String)
  case jobDelete(jobID: String)
  case taskList(status: String?, limit: Int?)
  case taskUpdate(taskID: String, action: String, until: String?)
  case providerAdd(providerID: String, apiKey: String, model: String?)
  case providerModelSet(providerID: String, model: String)
  case providerModelsList(providerID: String)

  public var type: String {
    switch self {
    case .hello: "hello"
    case .resync: "resync"
    case .msgSend: "msg.send"
    case .msgCancel: "msg.cancel"
    case .approveReply: "approve.reply"
    case .agentSelect: "agent.select"
    case .conversationOpen: "conversation.open"
    case .sessionNew: "session.new"
    case .conversationHistory: "conversation.history"
    case .threadOpen: "thread.open"
    case .threadList: "thread.list"
    case .threadHistory: "thread.history"
    case .jobList: "job.list"
    case .jobSet: "job.set"
    case .jobDelete: "job.delete"
    case .taskList: "task.list"
    case .taskUpdate: "task.update"
    case .providerAdd: "provider.add"
    case .providerModelSet: "provider.model.set"
    case .providerModelsList: "provider.models.list"
    }
  }

  /// Wire JSON. Hand-built, because implicit optionals must not travel.
  public func jsonObject() -> [String: Any] {
    var object: [String: Any] = ["type": type]
    switch self {
    case .hello(let v, let token, let device):
      object["v"] = v
      object["token"] = token
      object["device"] = device
    case .resync(let lastSeq):
      object["lastSeq"] = lastSeq
    case .msgSend(let threadID, let text, let files, let conversationID):
      if let threadID { object["threadID"] = threadID }
      object["text"] = text
      if let files, !files.isEmpty { object["files"] = files }
      if let conversationID { object["conversationID"] = conversationID }
    case .msgCancel(let turnID):
      object["turnID"] = turnID
    case .approveReply(let requestID, let decision):
      object["requestID"] = requestID
      object["decision"] = decision.wire
    case .agentSelect(let agentID):
      object["agentID"] = agentID
    case .conversationOpen(let conversationID, let agentID):
      object["conversationID"] = conversationID
      if let agentID { object["agentID"] = agentID }
    case .sessionNew(let conversationID):
      object["conversationID"] = conversationID
    case .conversationHistory(let conversationID, let limit):
      object["conversationID"] = conversationID
      if let limit { object["limit"] = limit }
    case .threadOpen(let threadID):
      object["threadID"] = threadID
    case .threadList(let limit):
      if let limit { object["limit"] = limit }
    case .threadHistory(let threadID, let limit):
      object["threadID"] = threadID
      if let limit { object["limit"] = limit }
    case .jobList(let limit):
      if let limit { object["limit"] = limit }
    case .jobSet(let jobID, let action):
      object["jobID"] = jobID
      object["action"] = action
    case .jobDelete(let jobID):
      object["jobID"] = jobID
    case .taskList(let status, let limit):
      if let status { object["status"] = status }
      if let limit { object["limit"] = limit }
    case .taskUpdate(let taskID, let action, let until):
      object["taskID"] = taskID
      object["action"] = action
      if let until { object["until"] = until }
    case .providerAdd(let providerID, let apiKey, let model):
      object["providerID"] = providerID
      object["apiKey"] = apiKey
      if let model { object["model"] = model }
    case .providerModelSet(let providerID, let model):
      object["providerID"] = providerID
      object["model"] = model
    case .providerModelsList(let providerID):
      object["providerID"] = providerID
    }
    return object
  }

  public func jsonData() throws -> Data {
    try JSONSerialization.data(withJSONObject: jsonObject())
  }

  public func jsonString() throws -> String {
    guard let text = String(data: try jsonData(), encoding: .utf8) else {
      throw ProtocolError.encoding("frame is not valid UTF-8")
    }
    return text
  }

  /// Decoding exists so the fixtures test can prove both directions.
  public init(wire value: Any) throws {
    guard let object = value as? [String: Any] else { throw ProtocolError.encoding("frame is not an object") }
    let type = try Require.string(object, "type")
    switch type {
    case "hello":
      self = .hello(
        v: try Require.int(object, "v"),
        token: try Require.string(object, "token"),
        device: try Require.string(object, "device"))
    case "resync":
      self = .resync(lastSeq: try Require.int(object, "lastSeq"))
    case "msg.send":
      self = .msgSend(
        threadID: object["threadID"] as? String,
        text: try Require.string(object, "text"),
        files: object["files"] as? [String],
        conversationID: object["conversationID"] as? String)
    case "msg.cancel":
      self = .msgCancel(turnID: try Require.string(object, "turnID"))
    case "approve.reply":
      self = .approveReply(
        requestID: try Require.string(object, "requestID"),
        decision: Decision(wire: try Require.string(object, "decision")))
    case "agent.select":
      self = .agentSelect(agentID: try Require.string(object, "agentID"))
    case "conversation.open":
      self = .conversationOpen(
        conversationID: try Require.string(object, "conversationID"),
        agentID: object["agentID"] as? String)
    case "session.new":
      self = .sessionNew(conversationID: try Require.string(object, "conversationID"))
    case "conversation.history":
      self = .conversationHistory(conversationID: try Require.string(object, "conversationID"), limit: object["limit"] as? Int)
    case "thread.open":
      self = .threadOpen(threadID: try Require.string(object, "threadID"))
    case "thread.list":
      self = .threadList(limit: object["limit"] as? Int)
    case "thread.history":
      self = .threadHistory(threadID: try Require.string(object, "threadID"), limit: object["limit"] as? Int)
    case "job.list":
      self = .jobList(limit: object["limit"] as? Int)
    case "job.set":
      self = .jobSet(jobID: try Require.string(object, "jobID"), action: try Require.string(object, "action"))
    case "job.delete":
      self = .jobDelete(jobID: try Require.string(object, "jobID"))
    case "task.list":
      self = .taskList(status: object["status"] as? String, limit: object["limit"] as? Int)
    case "task.update":
      self = .taskUpdate(taskID: try Require.string(object, "taskID"), action: try Require.string(object, "action"), until: object["until"] as? String)
    case "provider.add":
      self = .providerAdd(
        providerID: try Require.string(object, "providerID"),
        apiKey: try Require.string(object, "apiKey"),
        model: object["model"] as? String)
    case "provider.model.set":
      self = .providerModelSet(
        providerID: try Require.string(object, "providerID"),
        model: try Require.string(object, "model"))
    case "provider.models.list":
      self = .providerModelsList(providerID: try Require.string(object, "providerID"))
    default:
      throw ProtocolError.unknownFrameType(type)
    }
  }
}

// MARK: - server → client

public enum ServerFrame: Sendable, Equatable {
  case helloOK(HelloOK)
  case token(StreamToken)
  case turnStart(TurnStart)
  case turnEnd(TurnEnd)
  case toolStart(ToolStart)
  case toolUpdate(ToolUpdate)
  case toolEnd(ToolEnd)
  case approvalRequest(ApprovalRequest)
  case formRequest(FormRequest)
  case notify(Notify)
  case agentsUpdate(AgentsUpdate)
  case threadListOK(ThreadListOK)
  case threadHistoryOK(ThreadHistoryOK)
  case conversationOK(ConversationOK)
  case sessionStart(SessionStart)
  case conversationHistoryOK(ConversationHistoryOK)
  case jobListOK(JobListOK)
  case taskListOK(TaskListOK)
  case taskUpdateOK(TaskUpdateOK)
  case providerAddOK(ProviderAddOK)
  case providerModelsOK(ProviderModelsOK)
  case presence(Presence)
  case error(ErrorFrame)
  /// A frame this build does not know. Ignored, never fatal.
  case unknown(type: String, seq: Int)

  public var seq: Int {
    switch self {
    case .helloOK(let f): f.seq
    case .token(let f): f.seq
    case .turnStart(let f): f.seq
    case .turnEnd(let f): f.seq
    case .toolStart(let f): f.seq
    case .toolUpdate(let f): f.seq
    case .toolEnd(let f): f.seq
    case .approvalRequest(let f): f.seq
    case .formRequest(let f): f.seq
    case .notify(let f): f.seq
    case .agentsUpdate(let f): f.seq
    case .threadListOK(let f): f.seq
    case .threadHistoryOK(let f): f.seq
    case .conversationOK(let f): f.seq
    case .sessionStart(let f): f.seq
    case .conversationHistoryOK(let f): f.seq
    case .jobListOK(let f): f.seq
    case .taskListOK(let f): f.seq
    case .taskUpdateOK(let f): f.seq
    case .providerAddOK(let f): f.seq
    case .providerModelsOK(let f): f.seq
    case .presence(let f): f.seq
    case .error(let f): f.seq
    case .unknown(_, let seq): seq
    }
  }

  public var type: String {
    switch self {
    case .helloOK: "hello.ok"
    case .token: "token"
    case .turnStart: "turn.start"
    case .turnEnd: "turn.end"
    case .toolStart: "tool.start"
    case .toolUpdate: "tool.update"
    case .toolEnd: "tool.end"
    case .approvalRequest: "approval.request"
    case .formRequest: "form.request"
    case .notify: "notify"
    case .agentsUpdate: "agents.update"
    case .threadListOK: "thread.list.ok"
    case .threadHistoryOK: "thread.history.ok"
    case .conversationOK: "conversation.ok"
    case .sessionStart: "session.start"
    case .conversationHistoryOK: "conversation.history.ok"
    case .jobListOK: "job.list.ok"
    case .taskListOK: "task.list.ok"
    case .taskUpdateOK: "task.update.ok"
    case .providerAddOK: "provider.add.ok"
    case .providerModelsOK: "provider.models.ok"
    case .presence: "presence"
    case .error: "error"
    case .unknown(let type, _): type
    }
  }

  public struct HelloOK: Sendable, Equatable, Decodable {
    public var seq: Int
    public var v: Int
    public var serverTime: String
    public var lastSeq: Int
  }

  public struct StreamToken: Sendable, Equatable, Decodable {
    public var seq: Int
    public var turnID: String
    public var threadID: String
    public var delta: String
  }

  public struct TurnStart: Sendable, Equatable, Decodable {
    public var seq: Int
    public var turnID: String
    public var threadID: String
    public var agentID: String
    /// v2: the conversation this turn belongs to (present in both lanes).
    public var conversationID: String?
  }

  public struct TurnEnd: Sendable, Equatable, Decodable {
    public var seq: Int
    public var turnID: String
    public var threadID: String
    public var stopReason: String
    /// v2: the conversation the turn belongs to, when the server knows it.
    public var conversationID: String?
    public var usage: Usage?

    public var reason: StopReason { StopReason(wire: stopReason) }

    private enum CodingKeys: String, CodingKey {
      case seq, turnID, threadID, stopReason, usage
    }
  }

  public struct ToolStart: Sendable, Equatable, Decodable {
    public var seq: Int
    public var callID: String
    public var name: String
    public var preview: String?
  }

  public struct ToolUpdate: Sendable, Equatable, Decodable {
    public var seq: Int
    public var callID: String
    public var preview: String?
  }

  public struct ToolEnd: Sendable, Equatable, Decodable {
    public var seq: Int
    public var callID: String
    public var ok: Bool
    public var preview: String?
  }

  public struct ApprovalRequest: Sendable, Equatable, Decodable {
    public var seq: Int
    public var requestID: String
    public var action: String
    public var preview: String
    public var buttons: [String]

    public var decisions: [Decision] { buttons.map(Decision.init(wire:)) }
  }

  public struct FormRequest: Sendable, Equatable, Decodable {
    public var seq: Int
    public var requestID: String
    public var question: String
    public var options: [String]?
  }

  public struct Notify: Sendable, Equatable, Decodable {
    public var seq: Int
    public var title: String
    public var body: String
    public var sound: Bool?
    public var threadID: String?
  }

  public struct AgentsUpdate: Sendable, Equatable, Decodable {
    public var seq: Int
    public var agents: [AgentInfo]
  }

  public struct ThreadListOK: Sendable, Equatable, Decodable {
    public var seq: Int
    public var threads: [ThreadInfo]
  }

  public struct ThreadHistoryOK: Sendable, Equatable, Decodable {
    public var seq: Int
    public var threadID: String
    public var title: String?
    public var messages: [MessageInfo]
  }

  /// Answer to `conversation.open`: the agent's one conversation and its
  /// active session block. `sessionID` is "" while no block exists yet.
  public struct ConversationOK: Sendable, Equatable, Decodable {
    public var seq: Int
    public var conversationID: String
    public var agentID: String
    public var sessionID: String
  }

  /// A session block boundary inside the conversation (`/new` or context
  /// pressure). Frame `threadID`-shaped ids name blocks; `sessionID` is the
  /// block opened by this seam.
  public struct SessionStart: Sendable, Equatable, Decodable {
    public var seq: Int
    public var conversationID: String
    public var sessionID: String
    public var reason: String
  }

  public struct ConversationHistoryOK: Sendable, Equatable, Decodable {
    public var seq: Int
    public var conversationID: String
    public var messages: [MessageInfo]
  }

  public struct JobListOK: Sendable, Equatable, Decodable {
    public var seq: Int
    public var jobs: [JobInfo]
  }

  public struct TaskListOK: Sendable, Equatable, Decodable {
    public var seq: Int
    public var tasks: [TaskInfo]
  }

  public struct TaskUpdateOK: Sendable, Equatable, Decodable {
    public var seq: Int
    public var task: TaskInfo
  }

  public struct ProviderAddOK: Sendable, Equatable, Decodable {
    public var seq: Int
    public var providers: [ProviderInfo]
  }

  public struct ProviderModelsOK: Sendable, Equatable, Decodable {
    public var seq: Int
    public var providerID: String
    public var models: [String]
  }

  public struct Presence: Sendable, Equatable, Decodable {
    public var seq: Int
    public var state: String

    public var isOnline: Bool { state == "online" }
  }

  public struct ErrorFrame: Sendable, Equatable, Decodable {
    public var seq: Int
    public var code: String
    public var message: String
    public var retryAfter: Double?
  }

  /// Lenient on unknown types, strict inside a known one.
  public init(wire value: Any) throws {
    guard let object = value as? [String: Any] else { throw ProtocolError.decoding("frame is not an object") }
    let type = try Require.string(object, "type")
    switch type {
    case "hello.ok": self = .helloOK(try Decode.frame(HelloOK.self, object))
    case "token": self = .token(try Decode.frame(StreamToken.self, object))
    case "turn.start": self = .turnStart(try Decode.frame(TurnStart.self, object))
    case "turn.end": self = .turnEnd(try Decode.frame(TurnEnd.self, object))
    case "tool.start": self = .toolStart(try Decode.frame(ToolStart.self, object))
    case "tool.update": self = .toolUpdate(try Decode.frame(ToolUpdate.self, object))
    case "tool.end": self = .toolEnd(try Decode.frame(ToolEnd.self, object))
    case "approval.request": self = .approvalRequest(try Decode.frame(ApprovalRequest.self, object))
    case "form.request": self = .formRequest(try Decode.frame(FormRequest.self, object))
    case "notify": self = .notify(try Decode.frame(Notify.self, object))
    case "agents.update": self = .agentsUpdate(try Decode.frame(AgentsUpdate.self, object))
    case "thread.list.ok": self = .threadListOK(try Decode.frame(ThreadListOK.self, object))
    case "thread.history.ok": self = .threadHistoryOK(try Decode.frame(ThreadHistoryOK.self, object))
    case "conversation.ok": self = .conversationOK(try Decode.frame(ConversationOK.self, object))
    case "session.start": self = .sessionStart(try Decode.frame(SessionStart.self, object))
    case "conversation.history.ok": self = .conversationHistoryOK(try Decode.frame(ConversationHistoryOK.self, object))
    case "job.list.ok": self = .jobListOK(try Decode.frame(JobListOK.self, object))
    case "task.list.ok": self = .taskListOK(try Decode.frame(TaskListOK.self, object))
    case "task.update.ok": self = .taskUpdateOK(try Decode.frame(TaskUpdateOK.self, object))
    case "provider.add.ok": self = .providerAddOK(try Decode.frame(ProviderAddOK.self, object))
    case "provider.models.ok": self = .providerModelsOK(try Decode.frame(ProviderModelsOK.self, object))
    case "presence": self = .presence(try Decode.frame(Presence.self, object))
    case "error": self = .error(try Decode.frame(ErrorFrame.self, object))
    default: self = .unknown(type: type, seq: (object["seq"] as? Int) ?? 0)
    }
  }

  /// A JSON object with no `type` key is not a frame; used by the socket loop.
  public static func from(jsonText: String) throws -> ServerFrame {
    let value = try JSONSerialization.jsonObject(with: Data(jsonText.utf8))
    return try ServerFrame(wire: value)
  }
}

// MARK: - decoding support

public enum ProtocolError: Error, CustomStringConvertible {
  case encoding(String)
  case decoding(String)
  case unknownFrameType(String)

  public var description: String {
    switch self {
    case .encoding(let detail): "cannot encode frame: \(detail)"
    case .decoding(let detail): "cannot decode frame: \(detail)"
    case .unknownFrameType(let type): "unknown frame type: \(type)"
    }
  }
}

enum Require {
  static func string(_ object: [String: Any], _ key: String) throws -> String {
    guard let value = object[key] as? String else { throw ProtocolError.encoding("missing string field \(key)") }
    return value
  }

  static func int(_ object: [String: Any], _ key: String) throws -> Int {
    guard let value = object[key] as? Int else { throw ProtocolError.encoding("missing int field \(key)") }
    return value
  }
}

enum Decode {
  static func frame<T: Decodable>(_ type: T.Type, _ object: [String: Any]) throws -> T {
    let data = try JSONSerialization.data(withJSONObject: object)
    do {
      return try JSONDecoder().decode(type, from: data)
    } catch {
      throw ProtocolError.decoding("\(T.self): \(error)")
    }
  }
}
