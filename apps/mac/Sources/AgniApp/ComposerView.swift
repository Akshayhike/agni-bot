/** A full-width, bottom-anchored chat composer. */
import SwiftUI
import AgniKit

struct ComposerView: View {
  var model: AppModel
  var composerFocused: FocusState<Bool>
  var draft: Binding<String>
  var isActionsPresented = State(wrappedValue: false)

  var body: some View {
    HStack(alignment: .center, spacing: 10) {
      Button { isActionsPresented.wrappedValue.toggle() } label: {
        Image(systemName: "plus")
          .font(.system(size: 14, weight: .medium))
          .foregroundStyle(Color(hex: 0xA1A1AA))
          .frame(width: 30, height: 30)
          .background(Palette.surfaceRaised, in: Circle())
          .contentShape(Circle())
      }
      .buttonStyle(.plain)
      .help("Conversation actions")
      .accessibilityLabel("Conversation actions")
      .popover(isPresented: isActionsPresented.projectedValue, arrowEdge: .bottom) {
        VStack(alignment: .leading, spacing: 8) {
          Button("New conversation", systemImage: "square.and.pencil") {
            isActionsPresented.wrappedValue = false
            model.newThread()
          }
          .buttonStyle(.plain)
          Button("Switch agent…", systemImage: "person.crop.circle") {
            isActionsPresented.wrappedValue = false
            model.isAgentSwitcherPresented = true
          }
          .buttonStyle(.plain)
        }
        .padding(12)
      }

      TextField("", text: draft, axis: .vertical)
        .textFieldStyle(.plain)
        .font(Typography.body)
        .foregroundStyle(Palette.ink)
        .multilineTextAlignment(.leading)
        .frame(maxWidth: .infinity, alignment: .leading)
        .lineLimit(1...4)
        .focused(composerFocused.projectedValue)
        .padding(.vertical, 8)
        .overlay(alignment: .leading) {
          if draft.wrappedValue.isEmpty {
            Text(placeholder)
              .font(Typography.body)
              .foregroundStyle(Palette.inkTertiary)
              .allowsHitTesting(false)
          }
        }
        .accessibilityLabel(placeholder)
        .onSubmit(send)

      if model.conversation.isStreaming {
        Button { model.stopTurn() } label: {
          Image(systemName: "stop.fill")
            .font(.system(size: 12, weight: .bold))
            .foregroundStyle(Color(hex: 0x18181B))
            .frame(width: 32, height: 32)
            .background(Color(hex: 0xF3F3F3), in: Circle())
        }
        .buttonStyle(.plain)
        .keyboardShortcut(".", modifiers: .command)
        .help("Stop this turn (⌘.)")
        .accessibilityLabel("Stop")
      } else {
        Button { send() } label: {
          Image(systemName: draft.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "mic" : "arrow.up")
            .font(.system(size: 14, weight: .semibold))
            .foregroundStyle(Color(hex: 0x18181B))
            .frame(width: 32, height: 32)
            .background(Color(hex: 0xF3F3F3), in: Circle())
        }
        .buttonStyle(.plain)
        .disabled(draft.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        .help(draft.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "Voice input isn't available yet" : "Send")
        .accessibilityLabel(draft.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "Voice input unavailable" : "Send")
      }
    }
    .padding(.horizontal, 8)
    .frame(minHeight: 46)
    .background(Color(hex: 0x222225), in: Capsule())
    .overlay(Capsule().stroke(Color.white.opacity(0.12), lineWidth: 1))
    .padding(.horizontal, 20)
    .padding(.top, 12)
    .padding(.bottom, 18)
  }

  private var placeholder: String {
    model.conversation.isStreaming ? "Agni is writing…" : "Message \(model.agent?.name ?? "Agni")"
  }

  private func send() {
    let text = draft.wrappedValue
    guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
    draft.wrappedValue = ""
    model.send(text: text)
  }
}
