/**
 * Presentation of machine values — dates, durations, token counts, cadences.
 * Kept in one place so the app never invents a second way to say the same
 * thing, and so tests can pin the wording.
 */
import Foundation

public enum AgniFormat {
  // MARK: timestamps

  /// ISO-8601 as the server writes it, with or without fractional seconds.
  /// `Date.ISO8601FormatStyle` is a Sendable value, unlike ISO8601DateFormatter.
  private static let isoFractional = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
  private static let isoPlain = Date.ISO8601FormatStyle()

  public static func parseISO(_ text: String) -> Date? {
    (try? isoFractional.parse(text)) ?? (try? isoPlain.parse(text))
  }

  private static let clock = Date.FormatStyle(time: .shortened)
  private static let dayHeading = Date.FormatStyle().weekday(.wide).day().month(.wide)
  private static let shortDay = Date.FormatStyle().day().month(.abbreviated)

  public static func time(_ date: Date) -> String { date.formatted(clock) }

  /// Separator text for a day boundary in the transcript.
  public static func dayTitle(_ date: Date, now: Date = Date(), calendar: Calendar = .current) -> String {
    if calendar.isDate(date, inSameDayAs: now) { return "Today" }
    if let yesterday = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(date, inSameDayAs: yesterday) {
      return "Yesterday"
    }
    return date.formatted(dayHeading)
  }

  /// Timestamps on rows: clock time today, short date before that.
  public static func stamp(_ date: Date, now: Date = Date(), calendar: Calendar = .current) -> String {
    calendar.isDate(date, inSameDayAs: now) ? time(date) : date.formatted(shortDay)
  }

  /// Sidebar freshness: "now", "12m", "3h", then a date.
  public static func freshness(_ date: Date, now: Date = Date()) -> String {
    let seconds = now.timeIntervalSince(date)
    if seconds < 45 { return "now" }
    if seconds < 3600 { return "\(Int(seconds / 60))m" }
    if seconds < 86_400 { return "\(Int(seconds / 3600))h" }
    if seconds < 86_400 * 7 { return "\(Int(seconds / 86_400))d" }
    return date.formatted(shortDay)
  }

  // MARK: machine values

  public static func latency(_ milliseconds: Int?) -> String? {
    guard let milliseconds else { return nil }
    if milliseconds < 1000 { return "\(milliseconds) ms" }
    return String(format: "%.1f s", Double(milliseconds) / 1000)
  }

  public static func tokens(_ count: Int?) -> String? {
    guard let count else { return nil }
    if count < 1000 { return "\(count)" }
    if count < 100_000 { return String(format: "%.1fk", Double(count) / 1000) }
    return "\(count / 1000)k"
  }

  public static func uptime(_ milliseconds: Int) -> String {
    let seconds = milliseconds / 1000
    if seconds < 60 { return "\(seconds)s" }
    if seconds < 3600 { return "\(seconds / 60)m" }
    if seconds < 86_400 { return "\(seconds / 3600)h \(seconds % 3600 / 60)m" }
    return "\(seconds / 86_400)d \(seconds % 86_400 / 3600)h"
  }

  /// A routine reads as a cadence, not as a number of milliseconds.
  public static func cadence(everyMs: Int?, runAt: Date?, calendar: Calendar = .current) -> String {
    guard let everyMs, everyMs > 0 else {
      guard let runAt else { return "Once" }
      return "Once, \(dayTitle(runAt, now: Date(), calendar: calendar).lowercased()) at \(time(runAt))"
    }
    let minutes = everyMs / 60_000
    let hours = everyMs / 3_600_000

    if minutes < 1 { return "Every \(max(1, everyMs / 1000)) seconds" }
    if minutes < 60 {
      return "Every \(minutes) minute\(minutes == 1 ? "" : "s")"
    }
    if hours < 24, 24 % hours == 0 || hours % 24 != 0 {
      let anchored = runAt.map { " at \(time($0))" } ?? ""
      return "Every \(hours) hour\(hours == 1 ? "" : "s")\(anchored)"
    }
    let days = everyMs / 86_400_000
    guard let runAt else { return "Every \(days) day\(days == 1 ? "" : "s")" }
    let weekday = runAt.formatted(.dateTime.weekday(.wide))
    return days == 1
      ? "Every day at \(time(runAt))"
      : "Every \(weekday) at \(time(runAt))"
  }

  /// One-line, whitespace-collapsed preview for a list row.
  public static func preview(_ text: String, limit: Int = 140) -> String {
    let collapsed = text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    guard collapsed.count > limit else { return collapsed }
    return String(collapsed.prefix(limit)) + "…"
  }

  /// "53 site visitors", "1 turn" — counts that read naturally.
  public static func count(_ value: Int, _ noun: String) -> String {
    "\(value.formatted()) \(noun)\(value == 1 ? "" : "s")"
  }
}
