/**
 * One row of the transcript. A person's message is a bubble on the right;
 * Agni's reply is unfilled prose with the flame in the gutter, so long answers
 * read like something written to you rather than a card that was delivered.
 * Tool activity is a quiet strip under the reply it belongs to.
 */
import SwiftUI
import AgniKit
import AgniProtocol

struct MessageRowView: View {
  var message: ChatMessage
  var agent: AgentInfo?
  var onNotice: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      switch message.role {
      case .user:
        userBubble
      case .assistant:
        assistantProse
      case .system:
        if message.tools.isEmpty {
          systemNote
        } else {
          toolGroup(message.tools)
        }
      }
      if !message.tools.isEmpty && message.role != .system {
        toolGroup(message.tools)
      }
    }
    .frame(maxWidth: .infinity, alignment: message.role == .user ? .trailing : .leading)
  }

  // MARK: user

  private var userBubble: some View {
    VStack(alignment: .trailing, spacing: 4) {
      VStack(alignment: .leading, spacing: 5) {
        Text(message.text)
          .font(Typography.body)
          .foregroundStyle(Color(hex: 0x18181B))
          .textSelection(.enabled)
        if case .failed(let reason) = message.state {
          Text(reason)
            .font(Typography.caption)
            .foregroundStyle(Color(hex: 0x55554F))
        }
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 12)
      .background(Palette.outgoingBubble, in: RoundedRectangle(cornerRadius: Metrics.bubbleRadius, style: .continuous))
      .frame(maxWidth: 520, alignment: .trailing)
    }
  }

  // MARK: assistant

  private var assistantProse: some View {
    VStack(alignment: .leading, spacing: 8) {
      if message.text.isEmpty && message.isStreaming {
        ThinkingDots()
      } else if !message.text.isEmpty {
        ProseText(text: message.text, isStreaming: message.isStreaming)
      } else if case .failed(let reason) = message.state {
        Text(reason)
          .font(Typography.body)
          .foregroundStyle(Palette.ink)
      } else {
        Text("Agni couldn't complete this response.")
          .font(Typography.body)
          .foregroundStyle(Palette.ink)
      }
      if case .failed(let reason) = message.state, !message.text.isEmpty {
        Text(reason)
          .font(Typography.caption)
          .foregroundStyle(Palette.inkSecondary)
      }
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 12)
    .frame(maxWidth: 620, alignment: .leading)
    .background(Palette.incomingBubble, in: RoundedRectangle(cornerRadius: Metrics.bubbleRadius, style: .continuous))
  }

  // MARK: system + tools

  private var systemNote: some View {
    Text(message.text)
      .font(Typography.meta)
      .foregroundStyle(Palette.inkSecondary)
      .padding(.vertical, 2)
  }

  private func toolGroup(_ tools: [ToolActivity]) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      ForEach(tools) { tool in
        HStack(spacing: 7) {
          toolIcon(tool.state)
          Text(tool.name)
            .font(Typography.machine)
            .foregroundStyle(Palette.inkSecondary)
          if let preview = tool.preview, !preview.isEmpty {
            Text(AgniFormat.preview(preview, limit: 90))
              .font(Typography.machine)
              .foregroundStyle(Palette.inkTertiary)
              .lineLimit(1)
          }
          Spacer(minLength: 0)
        }
      }
    }
    .padding(.horizontal, 10)
    .padding(.vertical, 8)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Palette.surface, in: RoundedRectangle(cornerRadius: Metrics.rowRadius, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: Metrics.rowRadius, style: .continuous).stroke(Palette.hairline, lineWidth: 1)
    )
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Tool activity: \(tools.map(\.name).joined(separator: ", "))")
  }

  @ViewBuilder
  private func toolIcon(_ state: ToolActivity.State) -> some View {
    switch state {
    case .running:
      ProgressView().controlSize(.small).scaleEffect(0.6).frame(width: 12, height: 12)
    case .ok:
      Image(systemName: "checkmark").font(.system(size: 10, weight: .bold)).foregroundStyle(Palette.inkTertiary)
    case .failed:
      Image(systemName: "xmark").font(.system(size: 10, weight: .bold)).foregroundStyle(.orange)
    }
  }
}

/// Prose with inline code and links honoured, plus a caret while streaming.
struct ProseText: View {
  var text: String
  var isStreaming: Bool

  var body: some View {
    renderedText
      .font(Typography.body)
      .lineSpacing(4)
      .textSelection(.enabled)
      .fixedSize(horizontal: false, vertical: true)
  }

  /// Keep the streaming caret in the text layout so it follows the last
  /// character across wrapped lines instead of sitting at the end of an HStack.
  private var renderedText: Text {
    let prose = Text(attributed)
    guard isStreaming else { return prose }
    return prose + Text("|").foregroundColor(Palette.ember)
  }

  /// Runtime markdown, inline only: bold, italic, code, links.
  private var attributed: AttributedString {
    (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
      ?? AttributedString(text)
  }
}

/// Three dots while the first token is on its way.
struct ThinkingDots: View {
  var phase = State(wrappedValue: 0)
  var reduceMotion = Environment(\.accessibilityReduceMotion)

  var body: some View {
    HStack(spacing: 4) {
      ForEach(0..<3, id: \.self) { index in
        Circle()
          .fill(Palette.inkTertiary)
          .frame(width: 5, height: 5)
          .opacity(phase.wrappedValue == index ? 0.95 : 0.35)
      }
    }
    .accessibilityLabel("Agni is thinking")
    .onAppear {
      guard !reduceMotion.wrappedValue else { return }
      withAnimation(.linear(duration: 0.9).repeatForever(autoreverses: false)) { phase.wrappedValue = 1 }
      Timer.scheduledTimer(withTimeInterval: 0.3, repeats: true) { _ in
        Task { @MainActor in phase.wrappedValue = (phase.wrappedValue + 1) % 3 }
      }
    }
  }
}
