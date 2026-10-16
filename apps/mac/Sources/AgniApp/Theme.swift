/**
 * The design tokens from DESIGN.md, in one place. Colour, type, spacing and the
 * few motion values the app uses. Nothing here is decorative: every token is
 * referenced by a view, and the comments say what for.
 */
import SwiftUI
import AgniProtocol

/**
 * NOTE ON PROPERTY WRAPPERS
 *
 * This app is built with Command Line Tools only, which does not ship SwiftUI's
 * macro plugin, so `@State`, `@Binding`, `@Environment`, `@FocusState` and
 * `@NSApplicationDelegateAdaptor` are unavailable here. The wrappers are
 * therefore declared as explicit stored properties (`var phase = State(...)`)
 * and reached through `.wrappedValue` / `.projectedValue`.
 *
 * Installing Xcode restores the sugar; the wrappers are the same types, so the
 * change is mechanical (one `@` per declaration).
 */

enum Palette {
  /// Charcoal chat canvas; keeps the reference's soft, readable dark layers.
  static let canvas = Color(hex: 0x1C1C1C)
  static let sidebar = Color(hex: 0x141414)
  /// Rows, wells, sidebar selection.
  static let surface = Color(hex: 0x232326)
  static let surfaceRaised = Color(hex: 0x28282B)
  static let incomingBubble = Color(hex: 0x2A2A2D)
  static let outgoingBubble = Color(hex: 0xE8E8E3)
  /// 1px separators and card edges.
  static let hairline = Color(hex: 0xFFFFFF).opacity(0.07)
  static let ink = Color(hex: 0xF3F3F3)
  static let inkSecondary = Color(hex: 0x8A8A8E)
  static let inkTertiary = Color(hex: 0x71717A)
  /// Agni's identity and every live state. The only warm colour in the app.
  static let ember = Color(hex: 0xFF3146)
  static let emberDeep = Color(hex: 0xC4293C)
  /// The persona colour the server assigns, used for scheduled work.
  static let amber = Color(hex: 0xF0B95A)
}

enum Metrics {
  static let sidebarMin: CGFloat = 240
  static let sidebarIdeal: CGFloat = 268
  static let inspectorMin: CGFloat = 280
  static let inspectorIdeal: CGFloat = 320
  /// Chat column caps the measure so prose stays under ~80 characters.
  static let measure: CGFloat = 680
  static let gutter: CGFloat = 20
  static let rowRadius: CGFloat = 10
  static let bubbleRadius: CGFloat = 18
  static let cardRadius: CGFloat = 12
}

enum Typography {
  static let display = Font.system(size: 22, weight: .semibold)
  static let title = Font.system(size: 15, weight: .semibold)
  static let body = Font.system(size: 14)
  static let rowTitle = Font.system(size: 14, weight: .medium)
  static let meta = Font.system(size: 12)
  static let caption = Font.system(size: 11)
  static let machine = Font.system(size: 11, design: .monospaced)
  static let code = Font.system(size: 13, design: .monospaced)
}

extension Color {
  init(hex: UInt32) {
    self.init(
      .sRGB,
      red: Double((hex >> 16) & 0xFF) / 255,
      green: Double((hex >> 8) & 0xFF) / 255,
      blue: Double(hex & 0xFF) / 255,
      opacity: 1
    )
  }

  /// Server colours arrive as `#rrggbb`.
  init(serverHex: String) {
    let cleaned = serverHex.trimmingCharacters(in: CharacterSet(charactersIn: "# ")).lowercased()
    guard cleaned.count == 6, let value = UInt32(cleaned, radix: 16) else {
      self = Palette.amber
      return
    }
    self.init(hex: value)
  }
}

/// The flame. One shape, three sizes, and a pulse that means "working".
struct FlameMark: View {
  enum Size {
    case small
    case medium
    case large

    var points: CGFloat {
      switch self {
      case .small: 16
      case .medium: 26
      case .large: 56
      }
    }
  }

  var size: Size = .medium
  /// Live: the agent is producing tokens right now.
  var isAlive: Bool = false
  var reduceMotion = Environment(\.accessibilityReduceMotion)

  var body: some View {
    Image(systemName: "flame.fill")
      .font(.system(size: size.points, weight: .semibold))
      .foregroundStyle(
        LinearGradient(colors: [Palette.ember, Palette.emberDeep], startPoint: .top, endPoint: .bottom)
      )
      .shadow(color: Palette.ember.opacity(isAlive ? 0.45 : 0), radius: isAlive ? 8 : 0)
      .scaleEffect(isAlive && !reduceMotion.wrappedValue ? 1.04 : 1)
      .animation(reduceMotion.wrappedValue ? nil : .easeInOut(duration: 1.1).repeatForever(autoreverses: true), value: isAlive)
      .accessibilityHidden(true)
  }
}

/// Agent avatar: the flame for Agni, a coloured monogram for everyone else.
struct AgentAvatar: View {
  var agent: AgentInfo?
  var isAlive: Bool = false
  var size: FlameMark.Size = .medium

  var body: some View {
    if let agent, agent.id != "agni" {
      ZStack {
        Circle().fill(Color(serverHex: agent.colorHex).opacity(0.22))
        Text(monogram(agent.name))
          .font(.system(size: size.points * 0.42, weight: .semibold))
          .foregroundStyle(Color(serverHex: agent.colorHex))
      }
      .frame(width: size.points + 10, height: size.points + 10)
      .accessibilityLabel(agent.name)
    } else {
      FlameMark(size: size, isAlive: isAlive)
        .frame(width: size.points + 10, height: size.points + 10)
        .accessibilityLabel(agent?.name ?? "Agni")
    }
  }

  private func monogram(_ name: String) -> String {
    let initials = name.split(separator: " ").prefix(2).compactMap { $0.first }
    return String(initials).uppercased()
  }
}

/// Compact circular identity badge used in the thread list and chat header.
struct SidebarAgentBadge: View {
  var agent: AgentInfo?
  var size: CGFloat

  var body: some View {
    ZStack {
      Circle().fill(background)
      if agent == nil || agent?.id == "agni" {
        Image(systemName: "flame.fill")
          .font(.system(size: size * 0.48, weight: .semibold))
          .foregroundStyle(Color(hex: 0x18181B))
      } else {
        Text(initials)
          .font(.system(size: size * 0.34, weight: .semibold))
          .foregroundStyle(Color(hex: 0x18181B))
      }
    }
    .frame(width: size, height: size)
    .accessibilityLabel(agent?.name ?? "Agni")
  }

  private var background: Color {
    if let agent, agent.id != "agni" { return Color(serverHex: agent.colorHex) }
    return Color(hex: 0xEA9A3E)
  }

  private var initials: String {
    guard let agent else { return "A" }
    return String(agent.name.split(separator: " ").prefix(2).compactMap(\.first)).uppercased()
  }
}

/// Presence: a dot that is ember when the daemon is reachable, quiet when not.
struct PresenceDot: View {
  var isOnline: Bool

  var body: some View {
    Circle()
      .fill(isOnline ? Palette.ember : Palette.inkTertiary)
      .frame(width: 6, height: 6)
      .shadow(color: Palette.ember.opacity(isOnline ? 0.7 : 0), radius: 4)
      .accessibilityLabel(isOnline ? "Connected" : "Offline")
  }
}

/// A hairline that reads as structure, not decoration.
struct Hairline: View {
  var body: some View {
    Rectangle().fill(Palette.hairline).frame(height: 1)
  }
}
