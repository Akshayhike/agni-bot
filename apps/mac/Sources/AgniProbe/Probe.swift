/**
 * agni-probe — the Swift client without a window.
 *
 * It runs the same AgniKit connection the Mac app runs, so the protocol work is
 * proven against a live daemon before any UI is in the loop:
 *
 *   agni-probe "what is two plus two?"
 *   agni-probe --url ws://127.0.0.1:8787/ws --token agni_… --thread thr_x "…"
 *   AGNI_URL=… AGNI_TOKEN=… agni-probe --json --trace "…"
 */
import Foundation
import AgniKit
import AgniProtocol

@main
enum Probe {
  static func main() async {
    let runner = await MainActor.run { ProbeRunner() }
    await runner.run()
  }
}

@MainActor
final class ProbeRunner {
  private struct Outcome {
    var threadID = ""
    var turnID = ""
    var text = ""
    var firstTokenMs = -1
    var totalMs = 0
    var stopReason: StopReason?
    var failure: String?
  }

  private var outcome = Outcome()
  private let started = Date()
  private var trace: [String] = []
  private var deliver: ((Outcome) -> Void)?
  private var settled = false
  private var sent = false

  private let args: [String]
  private var url = ProcessInfo.processInfo.environment["AGNI_URL"] ?? "ws://127.0.0.1:8787/ws"
  private var token = ProcessInfo.processInfo.environment["AGNI_TOKEN"] ?? ""
  private var device = "agni-probe"
  private var threadID: String?
  private var timeout = 45.0
  private var json = false
  private var verbose = false
  private var question: [String] = []

  init() {
    args = Array(CommandLine.arguments.dropFirst())
  }

  func run() async {
    guard parse() else { return }
    guard !question.isEmpty else { return fail(Self.usage, code: 2) }
    guard !token.isEmpty else { return fail("no token — run `bun run pair`, then pass --token or AGNI_TOKEN", code: 2) }

    let settings = ServerSettings(url: url, deviceName: device, lastSeq: 0)
    guard let websocket = settings.websocketURL else { return fail("not a websocket URL: \(url)", code: 2) }

    let connection = AgniConnection(settings: ServerSettings(url: websocket.absoluteString, deviceName: device), token: token)
    let text = question.joined(separator: " ")

    connection.onEvent = { [weak self] event in
      self?.handle(event, connection: connection, text: text)
    }

    let result = await withCheckedContinuation { (continuation: CheckedContinuation<Outcome, Never>) in
      deliver = { continuation.resume(returning: $0) }
      connection.start()
      Task { @MainActor in
        try? await Task.sleep(for: .seconds(timeout))
        settle(failure: "probe timeout after \(Int(timeout))s")
      }
    }
    connection.stop()

    report(result)
  }

  // MARK: frames

  private func handle(_ event: AgniConnection.Event, connection: AgniConnection, text: String) {
    switch event {
    case .state(let state):
      trace.append("state \(stateName(state))")
      switch state {
      case .ready:
        send(connection: connection, text: text)
      case .refused(let reason):
        settle(failure: reason)
      default:
        break
      }

    case .frame(let frame):
      trace.append("\(frame.type)#\(frame.seq)")
      switch frame {
      case .turnStart(let start):
        if threadID == nil || start.threadID == threadID {
          outcome.threadID = start.threadID
          outcome.turnID = start.turnID
        }
      case .token(let token):
        guard outcome.turnID.isEmpty || token.turnID == outcome.turnID else { return }
        if outcome.firstTokenMs < 0 { outcome.firstTokenMs = elapsed() }
        outcome.text += token.delta
        FileHandle.standardOutput.write(Data(token.delta.utf8))
      case .turnEnd(let end):
        guard end.turnID == outcome.turnID else { return }
        outcome.stopReason = end.reason
        settle(failure: nil)
      case .error(let error):
        if outcome.firstTokenMs < 0 && !sent { settle(failure: "\(error.code): \(error.message)") }
      default:
        break
      }

    case .malformed(let detail):
      trace.append("malformed: \(detail)")

    case .durableReloadRequired:
      trace.append("resync_gap → reload durable state")

    case .lastSeq:
      break
    }
  }

  private func send(connection: AgniConnection, text: String) {
    guard !sent else { return }
    sent = true
    Task { @MainActor in
      do {
        try await connection.send(.msgSend(threadID: threadID ?? "", text: text, files: nil))
      } catch {
        settle(failure: "send failed: \(error)")
      }
    }
  }

  // MARK: settling

  private func settle(failure: String?) {
    guard !settled else { return }
    settled = true
    if let failure { outcome.failure = failure }
    outcome.totalMs = elapsed()
    deliver?(outcome)
    deliver = nil
  }

  private func elapsed() -> Int { Int(Date().timeIntervalSince(started) * 1000) }

  private func stateName(_ state: AgniConnection.State) -> String {
    switch state {
    case .idle: "idle"
    case .connecting: "connecting"
    case .handshaking: "handshaking"
    case .ready(let lastSeq): "ready(seq \(lastSeq))"
    case .waiting(let attempt, let seconds, let reason): "waiting(\(attempt), \(seconds)s, \(reason))"
    case .refused(let reason): "refused(\(reason))"
    case .stopped: "stopped"
    }
  }

  private func report(_ result: Outcome) {
    if json {
      let payload: [String: Any] = [
        "threadID": result.threadID,
        "turnID": result.turnID,
        "text": result.text,
        "firstTokenMs": result.firstTokenMs,
        "totalMs": result.totalMs,
        "stopReason": result.stopReason?.wire ?? "none",
        "failure": result.failure ?? "",
        "frames": trace,
      ]
      if let data = try? JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys]) {
        print(String(decoding: data, as: UTF8.self))
      }
    } else {
      FileHandle.standardError.write(
        Data(
          "— \(result.stopReason?.wire ?? "no turn.end") · first \(result.firstTokenMs)ms · total \(result.totalMs)ms · thread \(result.threadID.isEmpty ? "none" : result.threadID)\n"
            .utf8
        )
      )
      if verbose, !trace.isEmpty {
        FileHandle.standardError.write(Data((trace.joined(separator: " → ") + "\n").utf8))
      }
    }
    if let failure = result.failure {
      FileHandle.standardError.write(Data("\(failure)\n".utf8))
    }
    exit(result.stopReason == .end || (result.failure == nil && !result.text.isEmpty) ? 0 : 1)
  }

  // MARK: arguments

  private func parse() -> Bool {
    var index = 0
    while index < args.count {
      let arg = args[index]
      switch arg {
      case "--url": index += 1; url = value(index) ?? url
      case "--token": index += 1; token = value(index) ?? token
      case "--device": index += 1; device = value(index) ?? device
      case "--thread": index += 1; threadID = value(index)
      case "--timeout": index += 1; timeout = Double(value(index) ?? "45").map { $0 } ?? 45
      case "--json": json = true
      case "--trace": verbose = true
      case "--help", "-h":
        print(Self.usage)
        return false
      default:
        if arg.hasPrefix("--") {
          FileHandle.standardError.write(Data("unknown flag \(arg)\n".utf8))
          print(Self.usage)
          exit(2)
        }
        question.append(arg)
      }
      index += 1
    }
    return true
  }

  private func value(_ index: Int) -> String? {
    args.indices.contains(index) ? args[index] : nil
  }

  private func fail(_ message: String, code: Int32) {
    FileHandle.standardError.write(Data("\(message)\n".utf8))
    exit(code)
  }

  static let usage = """
  agni-probe — talk to the Agni daemon with the Mac app's own client.

    agni-probe [options] "question"

    --url ws://127.0.0.1:8787/ws   server (or AGNI_URL)
    --token agni_…                 device token from `bun run pair` (or AGNI_TOKEN)
    --device name                  device label sent in hello (default agni-probe)
    --thread thr_x                 continue an existing thread
    --timeout seconds              give up after this long (default 45)
    --json                         print one JSON object with the frame trace
    --trace                        print the frame trace to stderr
  """
}
