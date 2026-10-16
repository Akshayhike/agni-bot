/**
 * The thread: transcript, anything waiting for you, the composer, and a quiet
 * status strip. Prose is left-aligned in a capped measure; only day dividers
 * and system notes centre, because they belong to the thread, not to a person.
 */
import SwiftUI
import AgniKit
import AgniProtocol

struct ThreadView: View {
  var model: AppModel
  var composerFocused = FocusState<Bool>()
  var pinnedToBottom = State(wrappedValue: true)

  var body: some View {
    VStack(spacing: 0) {
      if model.conversation.messages.isEmpty {
        emptyState
      } else {
        transcript
      }
      PendingInbox(model: model)
      ComposerView(model: model, composerFocused: composerFocused, draft: draft.projectedValue)
    }
    .background(Palette.canvas)
    .onChange(of: model.focusComposerToken) { _, _ in composerFocused.wrappedValue = true }
  }

  var draft = State(wrappedValue: "")

  // MARK: transcript

  private var transcript: some View {
    ScrollViewReader { proxy in
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 16) {
          Color.clear.frame(height: 1).id(topAnchor)
          ForEach(Array(model.conversation.messages.enumerated()), id: \.element.id) { index, message in
            if isNewDay(index: index) {
              DayDivider(label: index == 0 ? AgniFormat.stamp(message.createdAt ?? Date()) : AgniFormat.dayTitle(message.createdAt ?? Date()))
            }
            MessageRowView(message: message, agent: model.agent, onNotice: { model.dismissToast() })
          }
          Color.clear.frame(height: 1).id(bottomAnchor)
        }
        .padding(.horizontal, Metrics.gutter + 6)
        .padding(.top, 18)
        .padding(.bottom, 22)
        .frame(maxWidth: 1040, alignment: .leading)
        .frame(maxWidth: .infinity, alignment: .center)
      }
      .defaultScrollAnchor(.top)
      .onScrollGeometryChange(for: Bool.self) { geometry in
        geometry.contentOffset.y + geometry.containerSize.height >= geometry.contentSize.height - 48
      } action: { _, nearBottom in
        pinnedToBottom.wrappedValue = nearBottom
      }
      .onChange(of: streamingText) { _, _ in
        guard pinnedToBottom.wrappedValue else { return }
        withAnimation(.linear(duration: 0.12)) { proxy.scrollTo(bottomAnchor, anchor: .bottom) }
      }
      .onChange(of: model.conversation.messages.count) { _, _ in
        guard pinnedToBottom.wrappedValue else { return }
        proxy.scrollTo(bottomAnchor, anchor: .bottom)
      }
      .onChange(of: model.conversation.threadID) { _, _ in
        if model.conversation.messages.count <= 2 {
          pinnedToBottom.wrappedValue = false
          proxy.scrollTo(topAnchor, anchor: .top)
        } else {
          pinnedToBottom.wrappedValue = true
          proxy.scrollTo(bottomAnchor, anchor: .bottom)
        }
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  private var streamingText: String {
    guard let id = model.conversation.streamingMessageID,
      let message = model.conversation.messages.first(where: { $0.id == id })
    else { return "" }
    return message.text
  }

  private let bottomAnchor = "agni.bottom"
  private let topAnchor = "agni.top"

  private func isNewDay(index: Int) -> Bool {
    let messages = model.conversation.messages
    guard index < messages.count, let date = messages[index].createdAt else { return false }
    if index == 0 { return true }
    guard let previous = messages[index - 1].createdAt else { return true }
    return !Calendar.current.isDate(previous, inSameDayAs: date)
  }

  private var emptyState: some View {
    VStack(spacing: 0) {
      Spacer(minLength: 0)
      Text("Start a conversation with \(model.agent?.name ?? "Agni")")
        .font(Typography.meta)
        .foregroundStyle(Palette.inkTertiary)
      Spacer().frame(height: 28)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .padding(.horizontal, Metrics.gutter + 6)
  }
}

/// Anything blocking the agent's next move sits directly above the composer.
private struct PendingInbox: View {
  var model: AppModel

  var body: some View {
    let approvals = model.conversation.openApprovals
    let forms = model.conversation.openForms
    if !approvals.isEmpty || !forms.isEmpty {
      VStack(spacing: 10) {
        ForEach(approvals) { approval in
          ApprovalCard(approval: approval) { decision in
            model.answer(approval: approval, decision: decision)
          }
        }
        ForEach(forms) { form in
          FormCard(form: form) { option in
            model.answer(form: form, option: option)
          }
        }
      }
      .frame(maxWidth: Metrics.measure + 60)
      .padding(.horizontal, Metrics.gutter + 6)
      .padding(.bottom, 12)
      .frame(maxWidth: .infinity, alignment: .center)
      .transition(.move(edge: .bottom).combined(with: .opacity))
    }
  }
}

private struct ApprovalCard: View {
  var approval: ApprovalRow
  var answer: (Decision) -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 8) {
        Image(systemName: "hand.raised.fill")
          .font(.system(size: 12))
          .foregroundStyle(Palette.ember)
        Text("Agni wants to run something")
          .font(Typography.rowTitle)
        Spacer(minLength: 0)
        Text(approval.id)
          .font(Typography.machine)
          .foregroundStyle(Palette.inkTertiary)
      }
      Text(approval.action)
        .font(Typography.code)
        .foregroundStyle(Palette.ink)
        .textSelection(.enabled)
      if !approval.preview.isEmpty {
        Text(approval.preview)
          .font(Typography.code)
          .foregroundStyle(Palette.inkSecondary)
          .lineLimit(6)
          .padding(10)
          .frame(maxWidth: .infinity, alignment: .leading)
          .background(Palette.canvas, in: RoundedRectangle(cornerRadius: Metrics.rowRadius, style: .continuous))
          .overlay(
            RoundedRectangle(cornerRadius: Metrics.rowRadius, style: .continuous).stroke(Palette.hairline, lineWidth: 1)
          )
          .textSelection(.enabled)
      }
      HStack(spacing: 8) {
        Spacer(minLength: 0)
        ForEach(approval.decisions, id: \.wire) { decision in
          if decision == .once {
            Button(decision.title) { answer(decision) }
              .buttonStyle(.borderedProminent)
              .tint(Palette.ember)
          } else {
            Button(decision.title) { answer(decision) }
              .buttonStyle(.bordered)
          }
        }
      }
    }
    .padding(14)
    .background(Palette.surface, in: RoundedRectangle(cornerRadius: Metrics.cardRadius, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: Metrics.cardRadius, style: .continuous).stroke(Palette.hairline, lineWidth: 1)
    )
  }
}

private struct FormCard: View {
  var form: FormRow
  var answer: (String) -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 8) {
        Image(systemName: "questionmark.bubble.fill")
          .font(.system(size: 12))
          .foregroundStyle(Palette.amber)
        Text(self.form.question)
          .font(Typography.rowTitle)
        Spacer(minLength: 0)
      }
      if !form.options.isEmpty {
        HStack(spacing: 8) {
          ForEach(form.options, id: \.self) { option in
            Button(option) { answer(option) }
              .buttonStyle(.bordered)
          }
          Spacer(minLength: 0)
        }
      }
      Text("Or answer in your own words below.")
        .font(Typography.caption)
        .foregroundStyle(Palette.inkTertiary)
    }
    .padding(14)
    .background(Palette.surface, in: RoundedRectangle(cornerRadius: Metrics.cardRadius, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: Metrics.cardRadius, style: .continuous).stroke(Palette.hairline, lineWidth: 1)
    )
  }
}

private struct DayDivider: View {
  var label: String

  var body: some View {
    Text(label)
      .font(Typography.caption)
      .foregroundStyle(Palette.inkSecondary)
      .frame(maxWidth: .infinity, alignment: .center)
    .padding(.vertical, 4)
    .accessibilityLabel(label)
  }
}
