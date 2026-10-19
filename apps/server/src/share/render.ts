/**
 * Thread export: a self-contained HTML document of one conversation.
 *
 * This is deliberately a pure function over a plain document — the DB read
 * lives in `document.ts`, so the markup can be tested without a database and
 * the builder can be tested without parsing HTML.
 *
 * Rules that matter:
 *  - No scripts, no external requests. The file must render correctly from a
 *    shared link, on a machine that has never seen Agni, offline.
 *  - Every value from the daemon is escaped. A message is data; it must never
 *    be able to become markup, which is also why nothing is interpolated
 *    unescaped and no markdown is interpreted server-side.
 *  - Tool calls and reasoning are included. The chat hides them because they
 *    are noise mid-conversation, but an export exists precisely so someone can
 *    audit what happened and why.
 */

export type ShareRecordKind = "user" | "agent" | "notice" | "tool" | "thinking" | "approval" | "error";

export interface ShareRecord {
  id: string;
  kind: ShareRecordKind;
  /** ISO timestamp; records are rendered in this order. */
  at: string;
  /** Who spoke — for agent rows, the speaking agent. */
  agentID?: string;
  agentName?: string;
  agentColor?: string;
  text?: string;
  /** Tool rows. */
  toolName?: string;
  args?: string;
  result?: string;
  ok?: boolean;
  durationMs?: number;
  /** Approval rows. */
  decision?: string;
  /** Error rows. */
  code?: string;
}

export interface ShareDocument {
  title: string;
  agentName: string;
  agentID: string;
  conversationID: string;
  createdAt: string;
  records: ShareRecord[];
}

export function escapeHTML(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Render the document. Deterministic: same input, byte-identical output. */
export function renderShareHTML(doc: ShareDocument): string {
  const records = [...doc.records].sort((a, b) => a.at.localeCompare(b.at));
  const counts = {
    messages: records.filter((record) => record.kind === "user" || record.kind === "agent").length,
    tools: records.filter((record) => record.kind === "tool").length,
  };
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="Agni">
<title>${escapeHTML(doc.title)}</title>
<style>
:root{--ink:#18181b;--ink2:#52525b;--ink3:#8b8b93;--line:#e7e5e4;--canvas:#ffffff;--raised:#faf9f7;--accent:#b4761c;--bad:#b4231c}
@media (prefers-color-scheme:dark){:root{--ink:#f4f4f5;--ink2:#b6b6bd;--ink3:#8b8b93;--line:#2c2c31;--canvas:#131316;--raised:#1b1b1f;--accent:#f0b95a;--bad:#f08a83}}
*{box-sizing:border-box}
body{margin:0;background:var(--canvas);color:var(--ink);font:15px/1.6 ui-sans-serif,-apple-system,"Segoe UI",sans-serif}
main{max-width:760px;margin:0 auto;padding:40px 20px 80px}
header{border-bottom:1px solid var(--line);padding-bottom:18px;margin-bottom:26px}
h1{font-size:20px;margin:0 0 6px}
.meta{color:var(--ink3);font-size:12.5px;margin:0}
.rec{margin:0 0 20px}
.who{display:flex;align-items:center;gap:7px;font-size:12.5px;color:var(--ink2);margin-bottom:5px}
.dot{width:8px;height:8px;border-radius:50%;background:var(--ink3);flex:none}
.body{white-space:pre-wrap;overflow-wrap:anywhere}
.user{display:flex;justify-content:flex-end}
.user .bubble{background:var(--raised);border:1px solid var(--line);border-radius:14px;padding:11px 15px;max-width:80%}
.user .who{justify-content:flex-end}
.notice{margin:0 auto 20px;text-align:center;color:var(--ink3);font-size:12.5px}
.notice .pill{border:1px solid var(--line);border-radius:999px;padding:4px 12px;display:inline-block}
.approval{margin:0 0 20px;font-size:12.5px;color:var(--ink2);border-left:3px solid var(--accent);padding:4px 0 4px 12px}
.error{margin:0 0 20px;color:var(--bad);font-size:13.5px}
details{border:1px solid var(--line);border-radius:10px;padding:8px 12px;margin:0 0 20px;background:var(--raised)}
details summary{cursor:pointer;font-size:12.5px;color:var(--ink2)}
summary::marker{color:var(--ink3)}
details .tag{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
details.ok .state{color:var(--ink3)}
details.bad .state{color:var(--bad)}
pre{margin:10px 4px 2px;padding:0;white-space:pre-wrap;overflow-wrap:anywhere;font:12.5px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--ink2)}
.label{color:var(--ink3);font-size:11px;text-transform:uppercase;letter-spacing:.06em;margin-top:10px}
.think .body{font-style:italic;color:var(--ink2)}
footer{margin-top:40px;border-top:1px solid var(--line);padding-top:14px;color:var(--ink3);font-size:12px}
@media print{body{background:#fff}details{break-inside:avoid}details[open]>*{display:block}}
</style>
</head>
<body>
<main>
<header>
<h1>${escapeHTML(doc.title)}</h1>
<p class="meta">${escapeHTML(doc.agentName)} · exported ${escapeHTML(doc.createdAt)} · ${counts.messages} message${counts.messages === 1 ? "" : "s"} · ${counts.tools} tool call${counts.tools === 1 ? "" : "s"}</p>
</header>
${records.map(renderRecord).join("\n")}
<footer>Exported from Agni. Tool calls and model reasoning are included for audit; the app itself keeps them out of the conversation view.</footer>
</main>
</body>
</html>
`;
}

function renderRecord(record: ShareRecord): string {
  const time = `<span>${escapeHTML(formatTime(record.at))}</span>`;
  switch (record.kind) {
    case "user": {
      return `<section class="rec user">
<div class="bubble" style="display:flex;flex-direction:column;align-items:flex-end">
<div class="who">${time}<span>You</span></div>
<div class="body">${escapeHTML(record.text ?? "")}</div>
</div>
</section>`;
    }
    case "agent": {
      const color = record.agentColor ? ` style="background:${escapeHTML(record.agentColor)}"` : "";
      return `<section class="rec">
<div class="who"><span class="dot"${color}></span><strong>${escapeHTML(record.agentName ?? record.agentID ?? "Agent")}</strong>${time}</div>
<div class="body">${escapeHTML(record.text ?? "")}</div>
</section>`;
    }
    case "notice":
      return `<section class="notice"><span class="pill">${escapeHTML(record.text ?? "")}</span></section>`;
    case "thinking":
      return `<section class="rec think">
<details><summary>Model reasoning${record.agentName ? ` · ${escapeHTML(record.agentName)}` : ""}</summary>
<div class="body">${escapeHTML(record.text ?? "")}</div>
</details>
</section>`;
    case "approval":
      return `<section class="rec">
<div class="who">${time}<span>Approval</span></div>
<div class="body">${escapeHTML(approvalLine(record))}</div>
</section>`;
    case "error":
      return `<section class="rec">
<div class="who">${time}<span>${escapeHTML(record.code ?? "error")}</span></div>
<div class="body" style="color:var(--bad)">${escapeHTML(record.text ?? "")}</div>
</section>`;
    case "tool": {
      const state = record.ok === false ? "failed" : record.ok === true ? "ok" : "…";
      const duration = record.durationMs !== undefined ? ` · ${record.durationMs}ms` : "";
      return `<section class="rec">
<details class="${record.ok === false ? "bad" : "ok"}">
<summary><span class="tag">${escapeHTML(record.toolName ?? "tool")}</span> · ${escapeHTML(state)}${escapeHTML(duration)}</summary>
<div class="label">Arguments</div><pre>${escapeHTML(record.args ?? "")}</pre>
<div class="label">Result</div><pre>${escapeHTML(record.result ?? "")}</pre>
</details>
</section>`;
    }
  }
}

function approvalLine(record: ShareRecord): string {
  const verb =
    record.decision === "reject" ? "was denied" : record.decision === "always" ? "was allowed, and remembered" : record.decision === "once" ? "was allowed once" : "was never answered";
  return `${record.text ?? "An action"} — ${verb}.`;
}

/** Local time, short. The export is read by a person, not a machine. */
function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return iso.slice(0, 10) === new Date().toISOString().slice(0, 10)
    ? iso.slice(11, 16)
    : `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}
