/**
 * Native two-column chat window: persistent conversation list and a unified
 * message pane. The inspector remains available from the Agni menu.
 */
import SwiftUI
import AgniKit
import AgniProtocol

struct RootView: View {
  var model: AppModel

  var body: some View {
    ZStack {
      Palette.canvas.ignoresSafeArea()
      switch model.screen {
      case .pairing:
        PairingView(model: model)
      case .chat:
        chat
      }
      if let toast = model.toast { toastOverlay(toast) }
    }
    .foregroundStyle(Palette.ink)
    .sheet(isPresented: model.agentSwitcherBinding) {
      AgentSwitcherView(model: model) { model.agentSwitcherBinding.wrappedValue = false }
    }
    .sheet(isPresented: model.settingsBinding) {
      SettingsView(model: model)
        .frame(minWidth: 680, minHeight: 560)
    }
  }

  private var chat: some View {
    HStack(spacing: 0) {
      SidebarView(model: model)
        .frame(width: 260)
      Rectangle()
        .fill(Palette.hairline)
        .frame(width: 1)
      VStack(spacing: 0) {
        ThreadHeader(model: model)
          .frame(height: 52)
        ThreadView(model: model)
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .background(Palette.canvas)
    }
    .background(Palette.canvas)
  }

  private func toastOverlay(_ toast: NoticeRow) -> some View {
    VStack {
      Spacer()
      HStack(alignment: .top, spacing: 10) {
        Image(systemName: toast.kind == .failure ? "exclamationmark.triangle.fill" : "bell.badge.fill")
          .font(.system(size: 13))
          .foregroundStyle(toast.kind == .failure ? Color.orange : Palette.ember)
        VStack(alignment: .leading, spacing: 2) {
          Text(toast.title).font(Typography.rowTitle)
          Text(toast.body)
            .font(Typography.meta)
            .foregroundStyle(Palette.inkSecondary)
            .fixedSize(horizontal: false, vertical: true)
        }
        Spacer(minLength: 0)
        Button { model.dismissToast() } label: {
          Image(systemName: "xmark").font(.system(size: 10, weight: .bold))
        }
        .buttonStyle(.plain)
        .foregroundStyle(Palette.inkTertiary)
        .accessibilityLabel("Dismiss")
      }
      .padding(12)
      .frame(maxWidth: 420)
      .background(Palette.surfaceRaised, in: RoundedRectangle(cornerRadius: Metrics.cardRadius, style: .continuous))
      .overlay(RoundedRectangle(cornerRadius: Metrics.cardRadius).stroke(Palette.hairline, lineWidth: 1))
      .shadow(color: .black.opacity(0.35), radius: 18, y: 6)
      .padding(.bottom, 24)
      .transition(.move(edge: .bottom).combined(with: .opacity))
      .onTapGesture { model.dismissToast() }
    }
    .animation(.snappy(duration: 0.22), value: toast.id)
  }
}
