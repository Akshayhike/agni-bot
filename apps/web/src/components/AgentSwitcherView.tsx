/** Command/Ctrl-K: pick another conversation surface. */
import { Check } from "lucide-react";
import { useAppModel, useAppSnapshot } from "../state/use-app-model";
import { AgentAvatar } from "./bits";

export function AgentSwitcherView() {
  const model = useAppModel();
  const snapshot = useAppSnapshot();
  return (
    <div
      className="overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) model.closeAgentSwitcher();
      }}
    >
      <div className="dialog" style={{ width: "min(340px, 100%)", padding: "16px 0 0" }} role="dialog" aria-label="Switch agent">
        <h2 style={{ padding: "0 16px 10px" }}>Switch agent</h2>
        <div className="switcher-list">
          {snapshot.agents.map((agent) => (
            <button
              type="button"
              key={agent.id}
              className="switcher-row"
              onClick={() => {
                model.selectAgent(agent);
                model.closeAgentSwitcher();
              }}
            >
              <AgentAvatar agent={agent} size="medium" />
              <span className="switcher-row-main">
                <span className="switcher-name">{agent.name}</span>
                <span className="switcher-model">{agent.model ?? "instant lane"}</span>
              </span>
              {agent.id === snapshot.conversation.agentID ? (
                <Check size={11} strokeWidth={2.6} color="var(--ember)" aria-label="Current agent" />
              ) : null}
            </button>
          ))}
        </div>
        <div className="dialog-actions" style={{ padding: 16, justifyContent: "flex-end" }}>
          <button type="button" className="btn" onClick={() => model.closeAgentSwitcher()}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
