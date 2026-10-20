/**
 * A full-width, bottom-anchored chat composer with slash commands above it.
 * Command-Enter sends; the composer stays a single quiet capsule.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ArrowUp, Mic, Plus, UserRound } from "lucide-react";
import { useAppModel, useAppSnapshot } from "../state/use-app-model";

interface Command {
  trigger: string;
  title: string;
  subtitle: string;
  action: () => void;
}

export function ComposerView() {
  const model = useAppModel();
  const snapshot = useAppSnapshot();
  const [draft, setDraft] = useState("");
  const [actionsOpen, setActionsOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const focusToken = useRef(snapshot.focusComposerToken);
  const isStreaming = snapshot.conversation.isStreaming;
  const trimmed = draft.trim();

  const commands: Command[] = [
    {
      trigger: "agent",
      title: "Switch agent…",
      subtitle: "Another conversation surface",
      action: () => model.openAgentSwitcher(),
    },
  ];

  const filtered = trimmed.startsWith("/")
    ? commands.filter((command) => {
        const term = trimmed.slice(1).toLowerCase();
        return command.trigger.startsWith(term) || command.title.toLowerCase().includes(term);
      })
    : [];

  useEffect(() => {
    if (snapshot.focusComposerToken === focusToken.current) return;
    focusToken.current = snapshot.focusComposerToken;
    const element = textareaRef.current;
    if (!element) return;
    element.focus();
    element.setSelectionRange(element.value.length, element.value.length);
  }, [snapshot.focusComposerToken]);

  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 116)}px`;
  }, [draft]);

  useEffect(
    () => () => {
      model.updateTypingState(false);
    },
    [model],
  );

  const submit = () => {
    if (trimmed.length === 0) return;
    if (trimmed.startsWith("/")) {
      const command = filtered[0];
      setDraft("");
      if (command) command.action();
      return;
    }
    const text = draft;
    setDraft("");
    model.updateTypingState(false);
    model.send(text);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      submit();
    }
  };

  return (
    <div className="composer-zone">
      {filtered.length > 0 ? (
        <div className="slash-menu" role="listbox">
          {filtered.map((command) => (
            <button
              type="button"
              key={command.trigger}
              className="slash-item"
              onClick={() => {
                setDraft("");
                command.action();
              }}
            >
              <span className="slash-trigger">/{command.trigger}</span>
              <span>{command.title}</span>
              <span className="slash-subtitle">{command.subtitle}</span>
            </button>
          ))}
        </div>
      ) : null}

      {actionsOpen ? (
        <>
          <div className="popover-backdrop" style={{ zIndex: 20 }} onClick={() => setActionsOpen(false)} />
          <div className="composer-popover" role="menu">
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setActionsOpen(false);
                model.openAgentSwitcher();
              }}
            >
              <UserRound size={13} />
              Switch agent…
            </button>
          </div>
        </>
      ) : null}

      <div className="composer">
        <button
          type="button"
          className="composer-plus"
          title="Conversation actions"
          aria-label="Conversation actions"
          onClick={() => setActionsOpen((open) => !open)}
        >
          <Plus size={14} />
        </button>

        <textarea
          ref={textareaRef}
          className="composer-input"
          rows={1}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            model.updateTypingState(event.target.value.trim().length > 0);
          }}
          onKeyDown={onKeyDown}
          placeholder={isStreaming ? "Agni is writing…" : `Message ${model.agent?.name ?? "Agni"}`}
          aria-label={isStreaming ? "Agni is writing" : `Message ${model.agent?.name ?? "Agni"}`}
        />

        {isStreaming ? (
          <button
            type="button"
            className="composer-stop"
            title="Stop this turn (⌘.)"
            aria-label="Stop"
            onClick={() => model.stopTurn()}
          >
            <span
              aria-hidden="true"
              style={{ width: 10, height: 10, borderRadius: 2, background: "currentColor" }}
            />
          </button>
        ) : (
          <button
            type="button"
            className="composer-send"
            disabled={trimmed.length === 0}
            title={trimmed.length === 0 ? "Voice input isn't available yet" : "Send (⌘⏎)"}
            aria-label={trimmed.length === 0 ? "Voice input unavailable" : "Send"}
            onClick={submit}
          >
            {trimmed.length === 0 ? <Mic size={14} /> : <ArrowUp size={15} strokeWidth={2.4} />}
          </button>
        )}
      </div>
    </div>
  );
}
