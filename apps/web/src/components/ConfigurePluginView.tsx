/**
 * Connect a plugin: the credentials it needs, entered once.
 *
 * The secrets go straight to the daemon over the authenticated socket and are
 * written into the daemon host's mode-600 plugins.json. The app keeps no copy
 * and never reads them back — this form is empty every time it opens.
 */
import { useState } from "react";
import type { PluginInfo } from "@agni/client";
import { useAppModel } from "../state/use-app-model";

export interface PluginCredentials {
  user?: string;
  pass?: string;
  key?: string;
  url?: string;
  clientID?: string;
  clientSecret?: string;
}

export function ConfigurePluginView({
  plugin,
  onDismiss,
}: {
  plugin: PluginInfo;
  onDismiss: () => void;
}) {
  const model = useAppModel();
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");
  const [key, setKey] = useState("");
  const [url, setUrl] = useState("");
  const [clientID, setClientID] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [saving, setSaving] = useState(false);

  const kind = plugin.authKind;
  const credentials: PluginCredentials =
    kind === "app-password"
      ? { user: user.trim(), pass }
      : kind === "api-key"
        ? { key: key.trim() || undefined, url: url.trim() || undefined }
        : { clientID: clientID.trim(), clientSecret };

  const ready =
    kind === "app-password"
      ? user.trim().length > 0 && pass.length > 0
      : kind === "api-key"
        ? key.trim().length > 0 || url.trim().length > 0
        : clientID.trim().length > 0 && clientSecret.length > 0;

  const submit = () => {
    if (!ready || saving) return;
    setSaving(true);
    model.configurePlugin(plugin.id, plugin.account, credentials);
    onDismiss();
  };

  return (
    <div
      className="overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onDismiss();
      }}
    >
      <div className="dialog wide" role="dialog" aria-label={`Connect ${plugin.name}`}>
        <div>
          <h2>Connect {plugin.name}</h2>
          <p style={{ marginTop: 4 }}>{plugin.description}</p>
        </div>

        {kind === "app-password" ? (
          <>
            <label className="field">
              <span className="field-label">Account email</span>
              <input
                className="text-input"
                value={user}
                onChange={(event) => setUser(event.target.value)}
                placeholder="you@example.com"
                aria-label="Account email"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <label className="field">
              <span className="field-label">App password</span>
              <input
                className="text-input"
                type="password"
                value={pass}
                onChange={(event) => setPass(event.target.value)}
                placeholder="App password"
                aria-label="App password"
                autoComplete="off"
              />
              <span className="settings-note">
                Google Account → Security → 2-Step Verification → App passwords. An app password
                works without Google verification, so nothing is sent to Google for review.
              </span>
            </label>
          </>
        ) : null}

        {kind === "api-key" ? (
          <>
            <label className="field">
              <span className="field-label">API key</span>
              <input
                className="text-input"
                type="password"
                value={key}
                onChange={(event) => setKey(event.target.value)}
                placeholder="Cloud API key"
                aria-label="API key"
                autoComplete="off"
              />
            </label>
            <label className="field">
              <span className="field-label">Self-hosted URL</span>
              <input
                className="text-input"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="http://127.0.0.1:3002"
                aria-label="Self-hosted URL"
                autoComplete="off"
                spellCheck={false}
              />
              <span className="settings-note">
                Leave the key empty to use a self-hosted instance instead of the cloud API.
              </span>
            </label>
          </>
        ) : null}

        {kind === "oauth" ? (
          <>
            <label className="field">
              <span className="field-label">Google client ID</span>
              <input
                className="text-input"
                value={clientID}
                onChange={(event) => setClientID(event.target.value)}
                placeholder="…apps.googleusercontent.com"
                aria-label="Google client ID"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <label className="field">
              <span className="field-label">Google client secret</span>
              <input
                className="text-input"
                type="password"
                value={clientSecret}
                onChange={(event) => setClientSecret(event.target.value)}
                placeholder="Client secret"
                aria-label="Google client secret"
                autoComplete="off"
              />
              <span className="settings-note">
                From a Google Cloud project with the Calendar or Drive API enabled. A browser
                opens next to sign in.
              </span>
            </label>
          </>
        ) : null}

        <span className="settings-note">
          The credentials are sent to your connected daemon and saved in the daemon host's
          mode-600 plugins.json file. The app does not keep a copy.
        </span>

        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onDismiss}>
            Cancel
          </button>
          <span className="spacer" />
          <button type="button" className="btn primary" disabled={!ready || saving} onClick={submit}>
            Connect
          </button>
        </div>
      </div>
    </div>
  );
}
