/** Searchable conversation roster with compact access to agents and tasks. */
import SwiftUI
import AgniKit
import AgniProtocol

struct SidebarView: View {
  var model: AppModel
  var deleteConfirmation = State(wrappedValue: false)
  var pendingDeleteTask = State<JobInfo?>(wrappedValue: nil)

  var body: some View {
    VStack(spacing: 0) {
      header
      searchField
      sections
      profileButton
    }
    .background(Palette.sidebar)
    .confirmationDialog(
      "Delete task?",
      isPresented: deleteConfirmation.projectedValue,
      titleVisibility: .visible
    ) {
      Button("Delete", role: .destructive) {
        if let task = pendingDeleteTask.wrappedValue { model.deleteTask(task) }
        pendingDeleteTask.wrappedValue = nil
      }
      Button("Cancel", role: .cancel) { pendingDeleteTask.wrappedValue = nil }
    } message: {
      Text("This removes the task from Agni. Running tasks cannot be deleted.")
    }
  }

  private var header: some View {
    HStack {
      Spacer()
      Button { model.newThread() } label: {
        Image(systemName: "plus")
          .font(.system(size: 16, weight: .medium))
          .foregroundStyle(Palette.inkSecondary)
          .frame(width: 30, height: 30)
          .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .help("New conversation for the selected agent")
      .accessibilityLabel("New conversation")
      .offset(y: -13)
    }
    .padding(.horizontal, 14)
    .frame(height: 52)
    .padding(.leading, 72)
    .padding(.trailing, 14)
  }

  private var searchField: some View {
    HStack(spacing: 8) {
      Image(systemName: "magnifyingglass")
        .font(.system(size: 12))
        .foregroundStyle(Palette.inkTertiary)
      TextField("Search", text: model.searchBinding)
        .textFieldStyle(.plain)
        .font(Typography.meta)
        .accessibilityLabel("Search conversations, agents, and tasks")
      if !model.searchText.isEmpty {
        Button { model.searchText = "" } label: {
          Image(systemName: "xmark.circle.fill")
            .foregroundStyle(Palette.inkTertiary)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Clear search")
      }
    }
    .padding(.horizontal, 12)
    .frame(height: 32)
    .background(Palette.surface, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    .padding(.horizontal, 12)
    .padding(.bottom, 14)
  }

  private var sections: some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 14) {
        VStack(alignment: .leading, spacing: 4) {
          sectionTitle("Conversations")
          if model.filteredThreads.isEmpty {
            sectionEmpty(model.searchText.isEmpty ? "Start a conversation with an agent" : "No matching conversations")
          } else {
            ForEach(model.filteredThreads) { thread in threadRow(thread) }
          }
        }
        VStack(alignment: .leading, spacing: 4) {
          sectionTitle("Agents")
          if model.filteredAgents.isEmpty {
            sectionEmpty(model.searchText.isEmpty ? "No agents available" : "No matching agents")
          } else {
            ForEach(model.filteredAgents) { agent in agentRow(agent) }
          }
        }

        VStack(alignment: .leading, spacing: 4) {
          HStack {
            sectionTitle("Tasks")
            Spacer()
            Button { model.refreshJobs() } label: {
              Image(systemName: "arrow.clockwise")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(Palette.inkTertiary)
            }
            .buttonStyle(.plain)
            .help("Refresh tasks")
          }
          if model.filteredJobs.isEmpty {
            sectionEmpty(model.searchText.isEmpty ? "No tasks scheduled" : "No matching tasks")
          } else {
            ForEach(model.filteredJobs) { task in taskRow(task) }
          }
        }
      }
      .padding(.horizontal, 8)
      .padding(.bottom, 12)
    }
    .scrollContentBackground(.hidden)
    .frame(maxHeight: .infinity)
  }

  private func threadRow(_ thread: ThreadInfo) -> some View {
    let selected = model.conversation.threadID == thread.id
    let agent = model.agents.first(where: { $0.id == thread.agentID })
    return Button { model.open(thread: thread) } label: {
      HStack(spacing: 10) {
        SidebarAgentBadge(agent: agent, size: 36)
        VStack(alignment: .leading, spacing: 3) {
          Text(thread.title?.isEmpty == false ? thread.title! : (agent?.name ?? "Conversation"))
            .font(Typography.rowTitle)
            .foregroundStyle(Palette.ink)
            .lineLimit(1)
          Text(thread.preview ?? agent?.name ?? "No messages yet")
            .font(Typography.meta)
            .foregroundStyle(Palette.inkSecondary)
            .lineLimit(1)
        }
        Spacer(minLength: 0)
        if model.unread.contains(thread.id) {
          Circle().fill(Palette.ember).frame(width: 6, height: 6)
        }
      }
      .padding(.horizontal, 10)
      .padding(.vertical, 9)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(selected ? Palette.surfaceRaised : .clear, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel("Open conversation \(thread.title ?? agent?.name ?? "Conversation")")
    .contextMenu {
      Button("Open conversation") { model.open(thread: thread) }
      Button("New conversation", systemImage: "square.and.pencil") {
        if let agent { model.selectAgent(agent) }
        model.newThread()
      }
    }
  }

  private func sectionTitle(_ title: String) -> some View {
    Text(title)
      .font(.system(size: 12, weight: .semibold))
      .foregroundStyle(Palette.inkTertiary)
      .padding(.horizontal, 12)
      .padding(.top, 2)
      .padding(.bottom, 5)
  }

  private func sectionEmpty(_ message: String) -> some View {
    Text(message)
      .font(Typography.meta)
      .foregroundStyle(Palette.inkTertiary)
      .padding(.horizontal, 12)
      .padding(.vertical, 8)
      .frame(maxWidth: .infinity, alignment: .leading)
  }

  private func agentRow(_ agent: AgentInfo) -> some View {
    let selected = model.conversation.agentID == agent.id
    return Button { model.selectAgent(agent) } label: {
      HStack(spacing: 10) {
        SidebarAgentBadge(agent: agent, size: 36)
        VStack(alignment: .leading, spacing: 3) {
          Text(agent.name)
            .font(Typography.rowTitle)
            .foregroundStyle(Palette.ink)
            .lineLimit(1)
          Text(model.threads.first(where: { $0.agentID == agent.id })?.preview ?? agent.model ?? "Assistant")
            .font(Typography.meta)
            .foregroundStyle(Palette.inkSecondary)
            .lineLimit(1)
        }
        Spacer(minLength: 0)
        if selected {
          Circle().fill(Palette.ember).frame(width: 6, height: 6)
        }
      }
      .padding(.horizontal, 10)
      .padding(.vertical, 9)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(selected ? Palette.surfaceRaised : .clear, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel("Open \(agent.name) chat")
    .contextMenu {
      Button("Open chat") { model.selectAgent(agent) }
      Button("New conversation", systemImage: "square.and.pencil") {
        model.selectAgent(agent)
        model.newThread()
      }
    }
  }

  private func taskRow(_ task: JobInfo) -> some View {
    HStack(spacing: 9) {
      Image(systemName: task.everyMs == nil ? "checklist" : "repeat")
        .font(.system(size: 14, weight: .medium))
        .foregroundStyle(Palette.amber)
        .frame(width: 30, height: 30)
        .background(Palette.surfaceRaised, in: Circle())

      Button { model.openTask(task) } label: {
        VStack(alignment: .leading, spacing: 3) {
          Text(task.title?.isEmpty == false ? task.title! : task.kind)
            .font(Typography.rowTitle)
            .foregroundStyle(Palette.ink)
            .lineLimit(1)
          Text(taskStatus(task))
            .font(Typography.caption)
            .foregroundStyle(Palette.inkSecondary)
            .lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .disabled(task.threadID == nil)
      .help(task.threadID == nil ? "This task has no chat yet" : "Open task chat")

      Button { model.runRoutine(task) } label: {
        Image(systemName: "play.fill")
          .font(.system(size: 10, weight: .semibold))
          .foregroundStyle(task.state == "running" ? Palette.inkTertiary : Palette.inkSecondary)
          .frame(width: 26, height: 28)
          .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .disabled(task.state == "running")
      .help(task.state == "running" ? "Task is running" : "Run task now")

      Button {
        pendingDeleteTask.wrappedValue = task
        deleteConfirmation.wrappedValue = true
      } label: {
        Image(systemName: "trash")
          .font(.system(size: 12, weight: .medium))
          .foregroundStyle(task.state == "running" ? Palette.inkTertiary : Palette.inkSecondary)
          .frame(width: 28, height: 28)
          .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .disabled(task.state == "running")
      .help(task.state == "running" ? "Running tasks cannot be deleted" : "Delete task")
      .accessibilityLabel("Delete \(task.title ?? task.kind)")
    }
    .padding(.horizontal, 9)
    .padding(.vertical, 7)
  }

  private func taskStatus(_ task: JobInfo) -> String {
    if task.state == "running" { return "Running" }
    if !task.enabled { return "Paused" }
    if task.state == "failed" { return "Failed" }
    return AgniFormat.cadence(everyMs: task.everyMs, runAt: AgniFormat.parseISO(task.runAt))
  }

  private var profileButton: some View {
    Button { model.isSettingsPresented = true } label: {
      HStack(spacing: 8) {
        Text(profileInitials)
          .font(.system(size: 11, weight: .medium))
          .foregroundStyle(Color(hex: 0xA1A1AA))
          .frame(width: 28, height: 28)
          .background(Palette.surfaceRaised, in: Circle())
        Text(profileName)
          .font(Typography.meta)
          .foregroundStyle(Color(hex: 0xD4D4D8))
          .lineLimit(1)
        Spacer(minLength: 0)
        if !model.connectionState.isReady {
          Image(systemName: "circle.fill")
            .font(.system(size: 7))
            .foregroundStyle(.orange)
            .help(connectionStatus)
        }
        Image(systemName: "chevron.up.chevron.down")
          .font(.system(size: 9, weight: .medium))
          .foregroundStyle(Palette.inkTertiary)
      }
      .padding(.horizontal, 16)
      .frame(height: 52)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .help("Settings, providers, and connection")
    .accessibilityLabel("Open settings for \(profileName)")
  }

  private var profileName: String {
    let device = model.settings.deviceName
    if let range = device.range(of: "'s ") { return String(device[..<range.lowerBound]) }
    return device.isEmpty ? "This Mac" : device
  }

  private var profileInitials: String {
    String(profileName.split(separator: " ").prefix(2).compactMap(\.first)).uppercased()
  }

  private var connectionStatus: String {
    switch model.connectionState {
    case .ready: "Connected"
    case .connecting, .handshaking: "Connecting…"
    case .waiting(let attempt, _, _): "Reconnecting · attempt \(attempt)"
    case .refused: "Needs attention"
    case .idle: "Starting"
    case .stopped: "Disconnected"
    }
  }
}
