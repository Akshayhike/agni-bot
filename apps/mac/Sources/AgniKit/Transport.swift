/**
 * WebSocket transport, abstracted so the connection loop can be driven by a
 * scripted fake in tests. One text frame in, one text frame out: the protocol
 * does the rest.
 */
import Foundation

public protocol FrameTransport: Sendable {
  func open(url: URL) async throws
  func send(_ text: String) async throws
  /// Next text frame. Throws when the socket closes or fails.
  func receive() async throws -> String
  func close() async
}

public enum TransportError: Error, Equatable, CustomStringConvertible {
  case closed(code: Int, reason: String)
  case failed(String)
  case notOpen

  public var description: String {
    switch self {
    case .closed(let code, let reason):
      reason.isEmpty ? "connection closed (\(code))" : "connection closed (\(code)): \(reason)"
    case .failed(let detail): detail
    case .notOpen: "connection is not open"
    }
  }
}

/// Records the close frame so `receive()` can report the server's code
/// (4001 hello timeout, 4002 version mismatch, 4003 unauthorized).
private final class CloseRecorder: NSObject, URLSessionWebSocketDelegate, @unchecked Sendable {
  private let lock = NSLock()
  private var recorded: (code: Int, reason: String)?

  func urlSession(
    _ session: URLSession,
    webSocketTask: URLSessionWebSocketTask,
    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
    reason: Data?
  ) {
    let text = reason.flatMap { String(data: $0, encoding: .utf8) } ?? ""
    lock.lock()
    recorded = (closeCode.rawValue, text)
    lock.unlock()
  }

  var close: (code: Int, reason: String)? {
    lock.lock()
    defer { lock.unlock() }
    return recorded
  }
}

public actor URLSessionTransport: FrameTransport {
  private let requestTimeout: TimeInterval
  private var session: URLSession?
  private var task: URLSessionWebSocketTask?
  private let recorder = CloseRecorder()

  public init(requestTimeout: TimeInterval = 10) {
    self.requestTimeout = requestTimeout
  }

  public func open(url: URL) async throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.timeoutIntervalForRequest = requestTimeout
    configuration.waitsForConnectivity = false
    configuration.httpAdditionalHeaders = [:]
    let session = URLSession(configuration: configuration, delegate: recorder, delegateQueue: nil)
    let task = session.webSocketTask(with: url)
    task.resume()
    self.session = session
    self.task = task
  }

  public func send(_ text: String) async throws {
    guard let task else { throw TransportError.notOpen }
    try await task.send(.string(text))
  }

  public func receive() async throws -> String {
    guard let task else { throw TransportError.notOpen }
    do {
      let message = try await task.receive()
      switch message {
      case .string(let text): return text
      case .data(let data): return String(decoding: data, as: UTF8.self)
      @unknown default: throw TransportError.failed("unsupported websocket payload")
      }
    } catch {
      if let close = recorder.close {
        throw TransportError.closed(code: close.code, reason: close.reason)
      }
      let code = task.closeCode.rawValue
      if code != URLSessionWebSocketTask.CloseCode.invalid.rawValue {
        let reason = task.closeReason.flatMap { String(data: $0, encoding: .utf8) } ?? ""
        throw TransportError.closed(code: code, reason: reason)
      }
      if let urlError = error as? URLError {
        throw TransportError.failed(urlError.localizedDescription)
      }
      throw TransportError.failed(error.localizedDescription)
    }
  }

  public func close() async {
    task?.cancel(with: .normalClosure, reason: nil)
    session?.invalidateAndCancel()
    task = nil
    session = nil
  }
}
