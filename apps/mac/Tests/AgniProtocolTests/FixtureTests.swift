/**
 * The contract test between the TypeScript protocol package and this Swift
 * mirror. `bun run fixtures` writes every frame shape to
 * packages/protocol/fixtures/frames.json; this suite decodes all of them, and
 * for client frames encodes them back and compares byte-for-byte. If TS and
 * Swift drift, `swift test` says so before a user ever sees a bad frame.
 */
import Foundation
import Testing

@testable import AgniProtocol

@Suite("protocol fixtures")
struct FixtureConformance {
  /// Walk up from this file to the repo that holds the fixture set. Counting
  /// directories is brittle the moment a test file moves; finding the fixture
  /// is not.
  static var fixtureURL: URL {
    var directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
    for _ in 0..<8 {
      let candidate = directory.appendingPathComponent("packages/protocol/fixtures/frames.json")
      if FileManager.default.fileExists(atPath: candidate.path) { return candidate }
      directory = directory.deletingLastPathComponent()
    }
    return URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .appendingPathComponent("packages/protocol/fixtures/frames.json")
  }

  static func load() throws -> (version: Int, client: [[String: Any]], server: [[String: Any]]) {
    let url = fixtureURL
    guard FileManager.default.fileExists(atPath: url.path) else {
      throw ProtocolError.decoding("missing \(url.path) — run: bun run fixtures")
    }
    let root = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any] ?? [:]
    let client = (root["client"] as? [[String: Any]]) ?? []
    let server = (root["server"] as? [[String: Any]]) ?? []
    return ((root["protocolVersion"] as? Int) ?? -1, client, server)
  }

  static func canonical(_ object: Any) throws -> Data {
    try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
  }

  @Test func fixturesCoverEveryFrameThisBuildKnows() throws {
    let fixtures = try Self.load()
    #expect(fixtures.version == PROTOCOL_VERSION, "PROTOCOL_VERSION drifted from the fixture set")

    let clientTypes = Set(fixtures.client.compactMap { $0["type"] as? String })
    for expected in [
      "hello", "resync", "msg.send", "msg.cancel", "approve.reply",
      "agent.select", "thread.open", "thread.list", "thread.history", "job.list", "job.set",
    ] {
      #expect(clientTypes.contains(expected), "no client fixture for \(expected) — run: bun run fixtures")
    }

    let serverTypes = Set(fixtures.server.compactMap { $0["type"] as? String })
    for expected in [
      "hello.ok", "token", "turn.start", "turn.end", "tool.start", "tool.update", "tool.end",
      "approval.request", "form.request", "notify", "agents.update", "thread.list.ok",
      "thread.history.ok", "job.list.ok", "presence", "error",
    ] {
      #expect(serverTypes.contains(expected), "no server fixture for \(expected) — run: bun run fixtures")
    }
  }

  @Test func clientFixturesDecodeAndReEncodeIdentically() throws {
    let fixtures = try Self.load()
    for object in fixtures.client {
      let type = object["type"] as? String ?? "?"
      let frame = try ClientFrame(wire: object)
      #expect(frame.type == type)
      let encoded = try Self.canonical(frame.jsonObject())
      let original = try Self.canonical(object)
      #expect(encoded == original, "\(type) does not survive a decode → encode round trip")
    }
  }

  @Test func serverFixturesDecode() throws {
    let fixtures = try Self.load()
    for object in fixtures.server {
      let type = object["type"] as? String ?? "?"
      let frame = try ServerFrame(wire: object)
      #expect(frame.type == type)
      #expect(frame.seq == (object["seq"] as? Int) ?? 0)
    }
  }

  @Test func decodedFieldsMatchTheWire() throws {
    let fixtures = try Self.load()
    func frame(_ type: String) throws -> ServerFrame {
      guard let object = fixtures.server.first(where: { $0["type"] as? String == type }) else {
        throw ProtocolError.decoding("no fixture for \(type)")
      }
      return try ServerFrame(wire: object)
    }

    guard case .helloOK(let hello) = try frame("hello.ok") else { Issue.record("hello.ok did not decode"); return }
    #expect(hello.v == PROTOCOL_VERSION)
    #expect(hello.lastSeq == hello.seq)

    guard case .token(let token) = try frame("token") else { Issue.record("token did not decode"); return }
    #expect(token.delta == "Call ")
    #expect(token.turnID == "trn_01hq")

    guard case .turnEnd(let end) = try frame("turn.end") else { Issue.record("turn.end did not decode"); return }
    #expect(end.reason == .end)
    #expect(end.usage?.latencyMs == 412)
    #expect(end.usage?.model == "llama-3.1-8b-instant")

    guard case .approvalRequest(let approval) = try frame("approval.request") else {
      Issue.record("approval.request did not decode"); return
    }
    #expect(approval.decisions == [.once, .always, .reject])
    #expect(approval.preview.contains("git push origin main"))

    guard case .formRequest(let form) = try frame("form.request") else {
      Issue.record("form.request did not decode"); return
    }
    #expect(form.options?.count == 3)

    guard case .notify(let note) = try frame("notify") else { Issue.record("notify did not decode"); return }
    #expect(note.sound == true)

    guard case .agentsUpdate(let roster) = try frame("agents.update") else {
      Issue.record("agents.update did not decode"); return
    }
    #expect(roster.agents.count == 2)
    #expect(roster.agents[1].model == "gemini-2.0-flash")
    #expect(roster.agents[1].tools == ["links.search"])

    guard case .threadListOK(let list) = try frame("thread.list.ok") else {
      Issue.record("thread.list.ok did not decode"); return
    }
    #expect(list.threads.count == 2)
    #expect(list.threads[1].title == nil)

    guard case .threadHistoryOK(let history) = try frame("thread.history.ok") else {
      Issue.record("thread.history.ok did not decode"); return
    }
    #expect(history.messages.map(\.role) == ["user", "assistant"])
    #expect(history.messages[1].turnID == "trn_01hq")

    guard case .presence(let presence) = try frame("presence") else {
      Issue.record("presence did not decode"); return
    }
    #expect(presence.isOnline == false)

    guard case .error(let error) = try frame("error") else { Issue.record("error did not decode"); return }
    #expect(error.code == "no_provider")
    #expect(error.retryAfter == 2)
  }

  @Test func toolFramesCarryPreview() throws {
    let fixtures = try Self.load()
    guard let object = fixtures.server.first(where: { $0["type"] as? String == "tool.end" }) else {
      Issue.record("no tool.end fixture"); return
    }
    guard case .toolEnd(let end) = try ServerFrame(wire: object) else {
      Issue.record("tool.end did not decode"); return
    }
    #expect(end.ok)
    #expect(end.preview == "3 matches")
  }

  @Test func unknownServerFrameTypeIsIgnoredNotFatal() throws {
    let frame = try ServerFrame(wire: ["type": "chart.render", "seq": 99, "whatever": 1])
    #expect(frame == .unknown(type: "chart.render", seq: 99))
    #expect(frame.seq == 99)
  }

  @Test func knownFrameWithABrokenPayloadFails() throws {
    #expect(throws: ProtocolError.self) {
      try ServerFrame(wire: ["type": "token", "seq": 1, "turnID": "trn_1"])
    }
    #expect(throws: ProtocolError.self) {
      try ServerFrame(wire: ["type": "hello.ok", "seq": 1, "v": 1, "serverTime": "now"])
    }
  }

  @Test func stopReasonAndDecisionSurviveUnknownValues() {
    #expect(StopReason(wire: "budget") == .budget)
    #expect(StopReason(wire: "paused").wire == "paused")
    #expect(StopReason(wire: "paused").explanation == "paused")
    #expect(Decision(wire: "always") == .always)
    #expect(Decision(wire: "later").title == "later")
  }
}
