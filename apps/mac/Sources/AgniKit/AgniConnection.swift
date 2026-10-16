/**
 * The connection loop: connect → hello → resync → stream, forever, with
 * backoff. One socket, one job.
 *
 * Two behaviours the P1 proof depends on:
 *   - Every connect sends `resync {lastSeq}`, and `lastSeq` survives relaunch.
 *     Kill the app mid-turn, reopen it, and the turn's frames replay into the
 *     reopened transcript.
 *   - `resync_gap` means the server cannot replay that far back, so we ask for
 *     durable state instead (thread list + history) — messages live in SQLite,
 *     replay is only a latency shortcut.
 */
import Foundation
import AgniProtocol

@MainActor
public final class AgniConnection {
  public enum State: Sendable, Equatable {
    case idle
    case connecting
    case handshaking
    case ready(lastSeq: Int)
    /// Transient: the loop is waiting to try again. `reason` is user-facing.
    case waiting(attempt: Int, seconds: Double, reason: String)
    /// Fatal for this configuration: retrying will not help until it changes.
    case refused(reason: String)
    case stopped

    public var isReady: Bool {
      if case .ready = self { return true }
      return false
    }

    public var isBusy: Bool {
      switch self {
      case .connecting, .handshaking, .waiting: true
      default: false
      }
    }
  }

  public enum Event: Sendable {
    case state(State)
    case frame(ServerFrame)
    /// A frame the server sent that this build could not parse.
    case malformed(String)
    /// `resync` could not be replayed: reload durable state.
    case durableReloadRequired
    /// lastSeq moved; persist it so a relaunch can resume.
    case lastSeq(Int)
  }

  public private(set) var state: State = .idle {
    didSet { if state != oldValue { onEvent?(.state(state)) } }
  }

  public var onEvent: ((Event) -> Void)?

  private let makeTransport: @Sendable () -> FrameTransport
  private let handshakeTimeout: Duration
  private let maxBackoffSeconds: Double
  private var transport: FrameTransport?
  private var loop: Task<Void, Never>?
  private var settings: ServerSettings
  private var token: String

  public init(
    settings: ServerSettings,
    token: String,
    makeTransport: @escaping @Sendable () -> FrameTransport = { URLSessionTransport() },
    handshakeTimeout: Duration = .seconds(12),
    maxBackoffSeconds: Double = 15
  ) {
    self.settings = settings
    self.token = token
    self.makeTransport = makeTransport
    self.handshakeTimeout = handshakeTimeout
    self.maxBackoffSeconds = maxBackoffSeconds
  }

  public var lastSeq: Int { settings.lastSeq }

  public func update(settings: ServerSettings, token: String) {
    stop()
    self.settings = settings
    self.token = token
  }

  public func start() {
    guard loop == nil else { return }
    loop = Task { [weak self] in await self?.run() }
  }

  public func stop() {
    loop?.cancel()
    loop = nil
    let socket = transport
    transport = nil
    state = .stopped
    Task { await socket?.close() }
  }

  /// Try now instead of waiting out the backoff.
  public func retryNow() {
    guard case .waiting = state else { return }
    loop?.cancel()
    loop = nil
    start()
  }

  public func send(_ frame: ClientFrame) async throws {
    guard let transport, state.isReady else { throw TransportError.notOpen }
    try await transport.send(try frame.jsonString())
  }

  // MARK: loop

  private func run() async {
    var attempt = 0
    while !Task.isCancelled {
      let reason: String
      do {
        reason = try await session()
        attempt = 0
        // A clean exit of session() (stop, or the server went away) still retries.
        if Task.isCancelled { break }
      } catch is CancellationError {
        break
      } catch let error as TransportError {
        if case .closed(let code, let text) = error, code == 4002 || code == 4003 {
          state = .refused(reason: text.isEmpty ? refusal(for: code) : text)
          break
        }
        reason = error.description
      } catch {
        reason = error.localizedDescription
      }

      if Task.isCancelled { break }
      attempt += 1
      let seconds = min(maxBackoffSeconds, 0.5 * pow(2, Double(attempt - 1)))
      state = .waiting(attempt: attempt, seconds: seconds, reason: reason)
      try? await Task.sleep(for: .seconds(seconds))
    }
    if case .refused = state { return }
    if !Task.isCancelled { state = .stopped }
  }

  private func refusal(for closeCode: Int) -> String {
    switch closeCode {
    case 4002: "Server speaks a different protocol version. Update the app or the server."
    case 4003: "This device token was revoked or is unknown. Pair again with bun run pair."
    default: "Connection refused by the server (\(closeCode))."
    }
  }

  /// One connection's lifetime. Returns a human reason when it ends.
  private func session() async throws -> String {
    state = .connecting
    guard let url = settings.websocketURL else {
      state = .refused(reason: "That server address is not a websocket URL.")
      throw CancellationError()
    }

    let socket = makeTransport()
    transport = socket
    defer {
      let ending = socket
      Task { await ending.close() }
    }

    try await socket.open(url: url)
    state = .handshaking
    try await socket.send(try ClientFrame.hello(v: PROTOCOL_VERSION, token: token, device: settings.deviceName).jsonString())

    let watchdog = Task { [handshakeTimeout] in
      try? await Task.sleep(for: handshakeTimeout)
      if Task.isCancelled { return }
      await socket.close()
    }
    defer { watchdog.cancel() }

    var greeted = false
    while !Task.isCancelled {
      let text: String
      do {
        text = try await socket.receive()
      } catch let error as TransportError {
        guard greeted else {
          // Nothing usable arrived: say what a person can act on.
          if case .closed(let code, _) = error, code == 4002 || code == 4003 { throw error }
          throw TransportError.failed(Self.greetingFailure(error))
        }
        return error.description
      }

      let frame: ServerFrame
      do {
        frame = try ServerFrame.from(jsonText: text)
      } catch {
        onEvent?(.malformed("\(error)"))
        continue
      }

      observe(seq: frame.seq)

      if !greeted {
        switch frame {
        case .helloOK(let hello):
          greeted = true
          watchdog.cancel()
          state = .ready(lastSeq: hello.lastSeq)
          // Re-enter the stream where this device left off.
          try? await socket.send(try ClientFrame.resync(lastSeq: settings.lastSeq).jsonString())
        case .error(let error):
          // The server rejects before hello.ok: unauthorized, version_mismatch.
          throw TransportError.closed(code: error.code == "version_mismatch" ? 4002 : 4003, reason: error.message)
        default:
          // Presence and other broadcasts can arrive before hello.ok; keep them.
          onEvent?(.frame(frame))
        }
        continue
      }

      if case .error(let error) = frame, error.code == "resync_gap" {
        onEvent?(.durableReloadRequired)
      }
      onEvent?(.frame(frame))
    }
    return "connection ended"
  }

  private func observe(seq: Int) {
    guard seq > settings.lastSeq else { return }
    settings.lastSeq = seq
    onEvent?(.lastSeq(seq))
  }

  private static func greetingFailure(_ error: TransportError) -> String {
    switch error {
    case .closed(let code, _) where code == 4001:
      "The server dropped the handshake (4001 hello timeout)."
    case .closed(_, let reason) where !reason.isEmpty:
      reason
    default:
      "No answer from \(error.description) — is the daemon running, and is this the right address?"
    }
  }
}
