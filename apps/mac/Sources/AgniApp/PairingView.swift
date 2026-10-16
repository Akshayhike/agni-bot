/**
 * Connection setup: find the daemon, then pair this Mac with its one-time
 * device token. The address and token are shown as separate, explained steps.
 */
import AppKit
import SwiftUI

struct PairingView: View {
  var model: AppModel
  var url: State<String>
  var token: State<String>
  var deviceName: State<String>
  var copiedCommand = State(wrappedValue: false)

  init(model: AppModel) {
    self.model = model
    url = State(initialValue: model.settings.url)
    token = State(initialValue: model.tokenForConnectionForm)
    deviceName = State(initialValue: model.settings.deviceName)
  }

  private var pairCommand: String {
    let safeName = deviceName.wrappedValue
      .replacingOccurrences(of: "\\", with: "\\\\")
      .replacingOccurrences(of: "\"", with: "\\\"")
    return "bun run pair --name \"\(safeName)\""
  }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 24) {
        HStack(spacing: 12) {
          FlameMark(size: .medium)
          VStack(alignment: .leading, spacing: 3) {
            Text("Connect to Agni")
              .font(.system(size: 24, weight: .semibold))
            Text("Connect this Mac to the machine running your assistant.")
              .font(Typography.body)
              .foregroundStyle(Palette.inkSecondary)
          }
        }

        VStack(alignment: .leading, spacing: 18) {
          VStack(alignment: .leading, spacing: 9) {
            stepHeading("1", title: "Where is your Agni server?")
            TextField("127.0.0.1:8787", text: url.projectedValue)
              .textFieldStyle(.plain)
              .font(Typography.body)
              .padding(12)
              .background(Palette.canvas, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
              .overlay(RoundedRectangle(cornerRadius: 10).stroke(Palette.hairline, lineWidth: 1))
            HStack(alignment: .top, spacing: 7) {
              Image(systemName: "info.circle")
              Text("Same Mac: leave 127.0.0.1:8787. Another machine: enter its Tailscale address, such as 100.x.x.x:8787.")
            }
            .font(Typography.meta)
            .foregroundStyle(Palette.inkSecondary)
          }

          Hairline()

          VStack(alignment: .leading, spacing: 9) {
            stepHeading("2", title: "Pair this Mac")
            Text("On the machine running Agni, run this command and copy the token it prints:")
              .font(Typography.meta)
              .foregroundStyle(Palette.inkSecondary)

            HStack(spacing: 8) {
              Text(pairCommand)
                .font(Typography.code)
                .foregroundStyle(Palette.ink)
                .textSelection(.enabled)
                .lineLimit(1)
                .truncationMode(.middle)
              Spacer(minLength: 0)
              Button {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(pairCommand, forType: .string)
                copiedCommand.wrappedValue = true
              } label: {
                Label(copiedCommand.wrappedValue ? "Copied" : "Copy", systemImage: copiedCommand.wrappedValue ? "checkmark" : "doc.on.doc")
                  .labelStyle(.titleAndIcon)
                  .font(Typography.caption)
              }
              .buttonStyle(.plain)
              .foregroundStyle(Palette.inkSecondary)
            }
            .padding(11)
            .background(Palette.canvas, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(Palette.hairline, lineWidth: 1))

            field("Device token") {
              SecureField("Paste the token shown by the command", text: token.projectedValue)
                .textFieldStyle(.plain)
                .font(Typography.body)
                .textContentType(.password)
            }

            field("Mac name") {
              TextField("This Mac", text: deviceName.projectedValue)
                .textFieldStyle(.plain)
                .font(Typography.body)
            }
            Text("The token is stored in Keychain and can be revoked from the server at any time.")
              .font(Typography.caption)
              .foregroundStyle(Palette.inkTertiary)
          }
        }

        if let error = model.pairingError {
          Label(error, systemImage: "exclamationmark.triangle.fill")
            .font(Typography.meta)
            .foregroundStyle(.orange)
            .fixedSize(horizontal: false, vertical: true)
        }

        if model.isPairing {
          HStack(spacing: 8) {
            ProgressView().controlSize(.small)
            Text(connectionStatus)
              .font(Typography.meta)
              .foregroundStyle(Palette.inkSecondary)
          }
          .frame(maxWidth: .infinity, alignment: .leading)
        }

        HStack {
          if model.tokenIsStored && !model.isPairing {
            Button("Back") { model.cancelConnectionEdit() }
              .buttonStyle(.plain)
              .foregroundStyle(Palette.inkSecondary)
          }
          Spacer()
          Button {
            model.pair(url: url.wrappedValue, token: token.wrappedValue, device: deviceName.wrappedValue)
          } label: {
            HStack(spacing: 8) {
              if model.isCheckingServer { ProgressView().controlSize(.small) }
              Text(model.isCheckingServer ? "Checking server…" : (model.isPairing ? "Connecting…" : "Connect"))
            }
            .frame(minWidth: 100)
          }
          .buttonStyle(.borderedProminent)
          .tint(Palette.ember)
          .controlSize(.large)
          .disabled(token.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.isCheckingServer || model.isPairing)
          .keyboardShortcut(.defaultAction)
        }
      }
      .padding(24)
      .frame(maxWidth: 560)
      .background(Palette.surface, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
      .overlay(RoundedRectangle(cornerRadius: 18).stroke(Palette.hairline, lineWidth: 1))
      .frame(maxWidth: .infinity, minHeight: 520, alignment: .center)
      .padding(28)
    }
    .background(Palette.canvas)
  }

  private var connectionStatus: String {
    switch model.connectionState {
    case .connecting: "Opening a private connection…"
    case .handshaking: "Checking this Mac's token…"
    case .waiting(_, let seconds, _): "Retrying in \(Int(seconds.rounded())) seconds…"
    case .ready: "Connected"
    case .refused(let reason): reason
    case .idle, .stopped: "Connecting to the Agni server…"
    }
  }

  private func stepHeading(_ number: String, title: String) -> some View {
    HStack(spacing: 9) {
      Text(number)
        .font(Typography.machine)
        .foregroundStyle(Palette.ember)
        .frame(width: 22, height: 22)
        .background(Palette.ember.opacity(0.12), in: Circle())
      Text(title).font(Typography.rowTitle)
    }
  }

  @ViewBuilder
  private func field(_ label: String, @ViewBuilder content: () -> some View) -> some View {
    VStack(alignment: .leading, spacing: 5) {
      Text(label)
        .font(Typography.meta)
        .foregroundStyle(Palette.inkSecondary)
      content()
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(Palette.canvas, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Palette.hairline, lineWidth: 1))
    }
  }
}
