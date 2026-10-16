/** App settings reached from the account control at the bottom of the sidebar. */
import SwiftUI
import AgniKit
import AgniProtocol

struct SettingsView: View {
  var model: AppModel
  var showingAddProvider = State(wrappedValue: false)
  var editingProvider = State<ProviderStatus?>(wrappedValue: nil)

  var body: some View {
    HStack(spacing: 0) {
      navigation
      Rectangle().fill(Palette.hairline).frame(width: 1)
      ScrollView {
        VStack(alignment: .leading, spacing: 24) {
          heading
          modelsSection
          connectionSection
          deviceSection
        }
        .padding(28)
        .frame(maxWidth: 760, alignment: .leading)
        .frame(maxWidth: .infinity, alignment: .leading)
      }
      .background(Palette.canvas)
    }
    .background(Palette.sidebar)
    .foregroundStyle(Palette.ink)
    .sheet(isPresented: showingAddProvider.projectedValue) {
      AddProviderView(model: model) { showingAddProvider.wrappedValue = false }
        .frame(minWidth: 380, minHeight: 360)
    }
    .sheet(item: editingProvider.projectedValue) { provider in
      ProviderModelEditor(model: model, provider: provider) { editingProvider.wrappedValue = nil }
        .frame(minWidth: 400, minHeight: 250)
    }
    .task { await model.refreshSettingsData() }
  }

  private var navigation: some View {
    VStack(alignment: .leading, spacing: 5) {
      Text("Settings")
        .font(.system(size: 17, weight: .semibold))
        .padding(.horizontal, 14)
        .padding(.top, 24)
        .padding(.bottom, 12)
      Label("Models & providers", systemImage: "cpu")
        .foregroundStyle(Palette.ink)
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Palette.surfaceRaised, in: RoundedRectangle(cornerRadius: 8))
      Label("Connection", systemImage: "network")
        .foregroundStyle(Palette.inkSecondary)
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
      Label("This Mac", systemImage: "laptopcomputer")
        .foregroundStyle(Palette.inkSecondary)
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
      Spacer()
      Button { model.isSettingsPresented = false } label: {
        Label("Back to chat", systemImage: "arrow.left")
          .foregroundStyle(Palette.inkSecondary)
          .padding(.horizontal, 12)
          .padding(.vertical, 10)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
      .buttonStyle(.plain)
      .padding(.bottom, 12)
    }
    .padding(.horizontal, 10)
    .frame(width: 210)
    .background(Palette.sidebar)
  }

  private var heading: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text("Models & providers")
        .font(.system(size: 24, weight: .semibold))
      Text("Connect API providers to the Agni daemon. Keys are stored on the server and never on this Mac.")
        .font(Typography.body)
        .foregroundStyle(Palette.inkSecondary)
        .fixedSize(horizontal: false, vertical: true)
    }
  }

  private var modelsSection: some View {
    VStack(alignment: .leading, spacing: 14) {
      HStack {
        VStack(alignment: .leading, spacing: 3) {
          Text("Connected providers").font(Typography.title)
          Text("Agni routes requests across available models automatically.")
            .font(Typography.meta).foregroundStyle(Palette.inkSecondary)
        }
        Spacer()
        Button {
          model.prepareToAddProvider()
          showingAddProvider.wrappedValue = true
        } label: {
          Label("Add provider", systemImage: "plus")
        }
        .buttonStyle(.borderedProminent)
        .tint(Palette.ember)
        .disabled(!model.connectionState.isReady)
      }
      if !model.configuredProviders.isEmpty {
        ForEach(model.configuredProviders) { provider in providerRow(provider) }
      } else if model.health != nil {
        emptyProviders
      } else {
        Text(model.healthError ?? "Waiting for the daemon status…")
          .font(Typography.meta).foregroundStyle(Palette.inkSecondary)
      }
      if let success = model.providerAddSuccess {
        Label(success, systemImage: "checkmark.circle.fill")
          .font(Typography.meta).foregroundStyle(.green)
      }
      Text("Supported API providers include Groq, Cerebras, NVIDIA NIM, Gemini, and OpenRouter. Local models can be served by LM Studio on the daemon host.")
        .font(Typography.caption)
        .foregroundStyle(Palette.inkTertiary)
        .fixedSize(horizontal: false, vertical: true)
      Text("Model choices are saved on the daemon in data/providers.json. Provider API keys stay in its mode-600 .env file.")
        .font(Typography.caption)
        .foregroundStyle(Palette.inkTertiary)
        .fixedSize(horizontal: false, vertical: true)
    }
    .padding(16)
    .background(Palette.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
  }

  private var emptyProviders: some View {
    VStack(alignment: .leading, spacing: 5) {
      Text("No model providers connected").font(Typography.rowTitle)
      Text("Add a provider key to let Agni answer using hosted models. The key is sent directly to your daemon.")
        .font(Typography.meta).foregroundStyle(Palette.inkSecondary)
    }
    .padding(.vertical, 8)
  }

  private func providerRow(_ provider: ProviderStatus) -> some View {
    HStack(spacing: 12) {
      Circle().fill(provider.available ? Color.green : Color.orange).frame(width: 8, height: 8)
      VStack(alignment: .leading, spacing: 3) {
        Text(provider.label).font(Typography.rowTitle)
        Text(provider.model).font(Typography.machine).foregroundStyle(Palette.inkSecondary)
        Text(provider.available ? provider.tiers.joined(separator: " · ") : (provider.lastError ?? "Unavailable"))
          .font(Typography.caption).foregroundStyle(provider.available ? Palette.inkTertiary : Color.orange)
      }
      Spacer()
      Text(provider.available ? "Ready" : "Needs attention")
        .font(Typography.caption)
        .foregroundStyle(provider.available ? Color.green : Color.orange)
      Button { editingProvider.wrappedValue = provider } label: {
        Image(systemName: "pencil")
          .font(.system(size: 12, weight: .medium))
          .foregroundStyle(Palette.inkSecondary)
          .frame(width: 28, height: 28)
      }
      .buttonStyle(.plain)
      .help("Choose model")
      .accessibilityLabel("Choose model for \(provider.label)")
    }
    .padding(.vertical, 8)
    .overlay(alignment: .bottom) { Rectangle().fill(Palette.hairline).frame(height: 1) }
  }

  private var connectionSection: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("Connection").font(Typography.title)
      HStack(spacing: 9) {
        PresenceDot(isOnline: model.connectionState.isReady)
        Text(connectionTitle).font(Typography.rowTitle)
      }
      Text(model.serverAddress).font(Typography.machine).foregroundStyle(Palette.inkSecondary)
      Button("Connection settings…") { model.editConnection() }
        .buttonStyle(.bordered)
    }
    .padding(16)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Palette.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
  }

  private var deviceSection: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text("This Mac").font(Typography.title)
      settingsRow("Device", model.settings.deviceName)
      settingsRow("Token storage", model.secretKind == .file ? "Secure local file" : "macOS Keychain")
      Button("Forget this device", role: .destructive) { model.forgetDevice() }
        .buttonStyle(.bordered)
    }
    .padding(16)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Palette.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
  }

  private func settingsRow(_ title: String, _ value: String) -> some View {
    HStack {
      Text(title).foregroundStyle(Palette.inkSecondary)
      Spacer()
      Text(value).foregroundStyle(Palette.ink).textSelection(.enabled)
    }
    .font(Typography.meta)
  }

  private var connectionTitle: String {
    model.connectionState.isReady ? "Agni is connected" : "Agni is disconnected"
  }
}

private struct ProviderModelEditor: View {
  var model: AppModel
  var provider: ProviderStatus
  var onDismiss: () -> Void
  var draft = State(wrappedValue: "")
  var selectedModel = State(wrappedValue: "")
  var isCustomModel = State(wrappedValue: false)

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      Text("Choose a model").font(.system(size: 18, weight: .semibold))
      Text("Enter a model ID supported by \(provider.label). The daemon will route future requests to it.")
        .font(Typography.meta).foregroundStyle(Palette.inkSecondary)
        .fixedSize(horizontal: false, vertical: true)
      if !model.providerModels.isEmpty {
        Picker("Available models", selection: selectedModel.projectedValue) {
          ForEach(model.providerModels, id: \.self) { modelID in
            Text(modelID).tag(modelID)
          }
          Text("Enter a custom model ID…").tag("__custom__")
        }
        .pickerStyle(.menu)
        .onChange(of: selectedModel.wrappedValue) { _, value in
          if value == "__custom__" {
            isCustomModel.wrappedValue = true
            draft.wrappedValue = ""
          } else {
            isCustomModel.wrappedValue = false
            draft.wrappedValue = value
          }
        }
      }
      if model.providerModels.isEmpty || isCustomModel.wrappedValue {
        TextField("Model ID", text: draft.projectedValue)
          .textFieldStyle(.roundedBorder)
      }
      if let error = model.providerModelsError {
        HStack {
          Text(error).font(Typography.caption).foregroundStyle(.orange)
          Spacer()
          Button("Retry") { model.loadProviderModels(providerID: provider.id) }
            .buttonStyle(.link).font(Typography.caption)
        }
      }
      if let error = model.providerAddError {
        Text(error).font(Typography.caption).foregroundStyle(.orange)
      }
      Spacer(minLength: 0)
      HStack {
        Button("Cancel") { onDismiss() }.keyboardShortcut(.cancelAction)
        Spacer()
        Button(model.isAddingProvider ? "Saving…" : "Save model") {
          model.setProviderModel(providerID: provider.id, model: draft.wrappedValue)
        }
        .buttonStyle(.borderedProminent)
        .tint(Palette.ember)
        .disabled(model.isAddingProvider || draft.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
      }
    }
    .padding(20)
    .background(Palette.canvas)
    .onAppear {
      draft.wrappedValue = provider.model
      selectedModel.wrappedValue = provider.model
      model.loadProviderModels(providerID: provider.id)
    }
    .onChange(of: model.providerModels) { _, models in
      guard !models.isEmpty else { return }
      let choice = models.contains(provider.model) ? provider.model : models[0]
      selectedModel.wrappedValue = choice
      draft.wrappedValue = choice
      isCustomModel.wrappedValue = false
    }
    .onChange(of: model.providerAddSuccess) { _, success in
      if success != nil { onDismiss() }
    }
  }
}
