/**
 * The roster, and nothing else. Each agent has one enduring conversation
 * surface; sessions are seams in it, not list entries (blueprint v3 §5).
 */
import { ChevronsUpDown, Puzzle, Search, X } from "lucide-react";
import { useAppModel, useAppSnapshot } from "../state/use-app-model";
import { SidebarAgentBadge, connectionShortStatus } from "./bits";

export function SidebarView() {
  const model = useAppModel();
  const snapshot = useAppSnapshot();
  const agents = model.filteredAgents;
  const connected = snapshot.plugins.filter((plugin) => plugin.status === "connected").length;
  const total = snapshot.plugins.length;

  return (
    <aside className="sidebar">
      <div className="sidebar-header" />

      <div className="sidebar-search">
        <Search size={12} aria-hidden="true" />
        <input
          value={snapshot.searchText}
          onChange={(event) => model.setSearchText(event.target.value)}
          placeholder="Search"
          aria-label="Search agents"
        />
        {snapshot.searchText.length > 0 ? (
          <button
            type="button"
            className="icon-btn"
            aria-label="Clear search"
            onClick={() => model.setSearchText("")}
          >
            <X size={12} />
          </button>
        ) : null}
      </div>

      <div className="sidebar-sections">
        <div className="sidebar-section-title">Agents</div>
        {agents.length === 0 ? (
          <div className="sidebar-empty">
            {snapshot.searchText.trim().length === 0 ? "No agents available" : "No matching agents"}
          </div>
        ) : (
          agents.map((agent) => {
            const selected = snapshot.conversation.agentID === agent.id;
            return (
              <button
                type="button"
                key={agent.id}
                className={`sidebar-row${selected ? " selected" : ""}`}
                onClick={() => model.selectAgent(agent)}
                aria-label={`Open ${agent.name} chat`}
                aria-current={selected ? "true" : undefined}
              >
                <SidebarAgentBadge agent={agent} size={36} />
                <span className="sidebar-row-text">
                  <span className="sidebar-row-title">{agent.name}</span>
                  <span className="sidebar-row-subtitle">{agent.role ?? agent.model ?? "Assistant"}</span>
                </span>
                {model.unreadBlocks(agent.id) ? <span className="unread-dot" aria-label="Unread" /> : null}
              </button>
            );
          })
        )}
      </div>

      <button
        type="button"
        className="sidebar-plugins"
        onClick={() => model.openSettings()}
        title="Connect plugins (Gmail, Calendar, Drive, Granola, Notion)"
        aria-label="Open plugins"
      >
        <span className="sidebar-plugins-icon">
          <Puzzle size={14} />
        </span>
        <span className="sidebar-plugins-label">Plugins</span>
        <span className="sidebar-plugins-count">
          {connected}/{total}
        </span>
      </button>

      <button
        type="button"
        className="sidebar-profile"
        onClick={() => model.openSettings()}
        title="Settings, providers, and connection"
        aria-label={`Open settings for ${profileName(snapshot.settings.deviceName)}`}
      >
        <span className="sidebar-profile-initials">{profileInitials(profileName(snapshot.settings.deviceName))}</span>
        <span className="sidebar-profile-name">{profileName(snapshot.settings.deviceName)}</span>
        {snapshot.connectionState.kind !== "ready" ? (
          <span
            className="presence-dot"
            style={{ background: "#f0a04b" }}
            title={connectionShortStatus(snapshot.connectionState)}
          />
        ) : null}
        <ChevronsUpDown size={9} aria-hidden="true" />
      </button>
    </aside>
  );
}

function profileName(deviceName: string): string {
  const marker = deviceName.indexOf("'s ");
  if (marker >= 0) return deviceName.slice(0, marker);
  return deviceName.trim().length === 0 ? "This Browser" : deviceName;
}

function profileInitials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => Array.from(part)[0] ?? "")
    .join("")
    .toUpperCase();
}
