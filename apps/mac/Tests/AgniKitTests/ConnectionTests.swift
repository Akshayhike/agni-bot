/**
 * AgniKit tests: the connection loop against a scripted socket, and the
 * transcript reducer against the frames the daemon actually sends.
 *
 * No network, no window, no clock dependency — the loop's timings are injected.
 */
import Foundation
import Synchronization
import Testing

@testable import AgniKit
@testable import AgniProtocol

/// A transport that hands out scripted frames and records what we sent.
final class FakeTransport: FrameTransport, @unchecked Sendable {
  private struct State {
    var queue: [Result<String, TransportError>]
    var sent: [String] = []
    var closed = false
    var openCount = 0
  }

  private let state: Mutex<State>

  init(script: [Result<String, TransportError>] = []) {
    state = Mutex(State(queue: script))
  }

  func open(url: URL) async throws {
    state.withLock { $0.openCount += 1 }
  }

  func send(_ text: String) async throws {
    state.withLock { $0.sent.append(text) }
  }

  func receive() async throws -> String {
    // Wait for a scripted frame; the connection loop drives the pace.
    for _ in 0..<400 {
      if let next = state.withLock({ $0.queue.isEmpty ? nil : $0.queue.removeFirst() }) {
        return try next.get()
      }
      try? await Task.sleep(for: .milliseconds(5))
    }
    throw TransportError.failed("fake transport ran out of frames")
  }

  func close() async {
    state.withLock { $0.closed = true }
  }

  var sentFrames: [String] {
    state.withLock { $0.sent }
  }

  var isClosed: Bool {
    state.withLock { $0.closed }
  }

  func decodedSent() -> [ClientFrame] {
    sentFrames.compactMap { text in
      guard let value = try? JSONSerialization.jsonObject(with: Data(text.utf8)) else { return nil }
      return try? ClientFrame(wire: value)
    }
  }
}

@MainActor
private func settle(_ condition: @escaping () -> Bool, timeout: Double = 3) async -> Bool {
  let deadline = Date().addingTimeInterval(timeout)
  while Date() < deadline {
    if condition() { return true }
    try? await Task.sleep(for: .milliseconds(10))
  }
  return condition()
}

@Suite("connection")
@MainActor
struct ConnectionTests {
  private func settings(lastSeq: Int = 0) -> ServerSettings {
    ServerSettings(url: "ws://127.0.0.1:8787/ws", deviceName: "Test Mac", lastSeq: lastSeq)
  }

  @Test func handshakeThenResyncFromTheStoredSeq() async {
    let transport = FakeTransport(script: [
      .success(#"{"type":"hello.ok","seq":7,"v":1,"serverTime":"2026-10-16T12:00:00.000Z","lastSeq":7}"#),
      .success(#"{"type":"presence","seq":8,"state":"online"}"#),
    ])

    var states: [AgniConnection.State] = []
    var frames: [ServerFrame] = []
    let connection = AgniConnection(
      settings: settings(lastSeq: 3),
      token: "agni_test",
      makeTransport: { transport },
      handshakeTimeout: .seconds(5)
    )
    connection.onEvent = { event in
      switch event {
      case .state(let state): states.append(state)
      case .frame(let frame): frames.append(frame)
      default: break
      }
    }
    connection.start()

    #expect(await settle { connection.state.isReady })
    #expect(await settle { frames.contains { $0.type == "presence" } })
    connection.stop()

    let sent = transport.decodedSent()
    #expect(sent.first == .hello(v: PROTOCOL_VERSION, token: "agni_test", device: "Test Mac"))
    // resync asks for everything after the persisted seq, not from zero.
    #expect(sent.contains(.resync(lastSeq: 3)))
    #expect(states.contains { if case .ready = $0 { return true } else { return false } })
  }

  @Test func lastSeqAdvancesWithTheStreamAndIsReported() async {
    let transport = FakeTransport(script: [
      .success(#"{"type":"hello.ok","seq":1,"v":1,"serverTime":"now","lastSeq":1}"#),
      .success(#"{"type":"token","seq":2,"turnID":"trn_1","threadID":"thr_1","delta":"hi"}"#),
      .success(#"{"type":"turn.end","seq":3,"turnID":"trn_1","threadID":"thr_1","stopReason":"end"}"#),
    ])

    var observed: [Int] = []
    let connection = AgniConnection(settings: settings(), token: "t", makeTransport: { transport }, handshakeTimeout: .seconds(5))
    connection.onEvent = { event in
      if case .lastSeq(let seq) = event { observed.append(seq) }
    }
    connection.start()
    #expect(await settle { observed.contains(3) })
    connection.stop()
    #expect(connection.lastSeq == 3)
    #expect(observed == observed.sorted())
  }

  @Test func revokedTokenStopsRetrying() async {
    let transport = FakeTransport(script: [
      .success(#"{"type":"error","seq":1,"code":"unauthorized","message":"unknown or revoked token — pair a device first"}"#)
    ])
    let connection = AgniConnection(settings: settings(), token: "bad", makeTransport: { transport }, handshakeTimeout: .seconds(2))
    connection.start()
    #expect(
      await settle({ if case .refused = connection.state { return true } else { return false } }, timeout: 4))
    if case .refused(let reason) = connection.state {
      #expect(reason.contains("revoked") || reason.contains("unknown"))
    } else {
      Issue.record("expected a refusal, got \(connection.state)")
    }
    connection.stop()
  }

  @Test func resyncGapAsksForDurableState() async {
    let transport = FakeTransport(script: [
      .success(#"{"type":"hello.ok","seq":9,"v":1,"serverTime":"now","lastSeq":9}"#),
      .success(#"{"type":"error","seq":10,"code":"resync_gap","message":"cannot replay from 1"}"#),
    ])
    var reloads = 0
    let connection = AgniConnection(settings: settings(), token: "t", makeTransport: { transport }, handshakeTimeout: .seconds(5))
    connection.onEvent = { event in
      if case .durableReloadRequired = event { reloads += 1 }
    }
    connection.start()
    #expect(await settle { reloads == 1 })
    connection.stop()
  }

  @Test func unknownFramesAreIgnoredAndBadOnesAreReported() async {
    let transport = FakeTransport(script: [
      .success(#"{"type":"hello.ok","seq":1,"v":1,"serverTime":"now","lastSeq":1}"#),
      .success(#"{"type":"chart.render","seq":2,"chart":"burn"}"#),
      .success(#"{"type":"token","seq":3,"delta":"missing ids"}"#),
      .success(#"{"type":"presence","seq":4,"state":"online"}"#),
    ])
    var malformed: [String] = []
    var types: [String] = []
    let connection = AgniConnection(settings: settings(), token: "t", makeTransport: { transport }, handshakeTimeout: .seconds(5))
    connection.onEvent = { event in
      switch event {
      case .malformed(let detail): malformed.append(detail)
      case .frame(let frame): types.append(frame.type)
      default: break
      }
    }
    connection.start()
    #expect(await settle { types.contains("presence") })
    connection.stop()
    #expect(types.contains("chart.render"))
    #expect(malformed.count == 1)
    #expect(malformed.first?.contains("token") == true)
  }

  @Test func sendBeforeReadyFailsInsteadOfDroppingTheMessage() async {
    let transport = FakeTransport()
    let connection = AgniConnection(settings: settings(), token: "t", makeTransport: { transport }, handshakeTimeout: .seconds(5))
    await #expect(throws: TransportError.self) {
      try await connection.send(.msgSend(threadID: "", text: "hello", files: nil, conversationID: nil, channelId: nil, toAgentId: nil, texts: nil))
    }
  }
}
