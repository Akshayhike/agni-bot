# Research Brief: Context & Memory Management for a Single-Interface Agent System

> **How to use this brief:** this is a self-contained research prompt. Give it to a
> research agent. It should investigate, then return **two artifacts** (a Markdown
> document and a single self-contained HTML page) that tell us exactly how to build
> context management for the product described below. No question is optional; if a
> section cannot be answered from public knowledge, say so and give the best
> available answer with sources.

---

## 1. What it needs to do (the research)

Research and design the **context-management and memory system** for a personal
assistant where the user talks to **one interface** that feels like a continuous
conversation with a friend, while the backend runs **many sessions, threads, and
specialist agents**. The user must never see the machinery: they should not know
when a new session starts, when a session continues, when context is pulled, or when
work is handed to another agent. All of that is managed silently by the system.

Concretely, the research must cover:

- **Context management across a single interface.** How to present one continuous
  conversation while the backend manages multiple session blocks, compaction, and
  context retrieval — without the user ever perceiving a boundary.
- **A super-efficient memory management system.** How an agent stores, retrieves,
  consolidates, and forgets information so that a single assistant (and the
  specialists it spawns) can work over a long-lived conversation without losing
  context or wasting tokens.
- **Background delegation.** How a single "chief of staff" agent routes tasks to
  specialist agents, tracks their progress, aggregates results, and keeps the user
  updated — while the user just sees one chat.
- **Efficiency.** How to minimize token cost and latency across many agents and
  sessions; what to share vs. isolate; where caching helps.

## 2. The product we are building (the vision)

- **One chat interface.** The user chats like they're talking to a friend. They
  give tasks; the system does them. There are no visible sessions, no visible
  thread switches, no visible "context pulled" moments.
- **One primary bot: an executive assistant / chief of staff.** It is the single
  entry point. The user creates only this one bot.
- **It hires or creates more agents and communicates with them.** The user gives a
  task to the executive assistant; it delegates to a specialist (for example a
  research agent); the specialist does the work and sends the result back; the
  executive assistant keeps the user updated. The work is done by different agents.
- **All agents live inside a computer.** The workload is split across agents so
  that no single model or agent feels constrained. Each agent focuses on the
  specific task it is allocated — research, email, communication, or anything else.
- **The user never manages agents.** They talk to one bot; the bot orchestrates
  everything else in the background.

## 3. Current implementation (what Agni does today)

This is the system the design must extend. Be specific about how it works now.

- **Conversation model.** One conversation per agent; it never resets. Inside a
  conversation, **session blocks** (threads) rotate: when a block fills, it is
  closed into a carried summary and a new block opens. The user sees one continuous
  transcript; the backend manages the blocks.
- **Channels.** A `main` channel for the executive assistant; `dm:<agent>` channels
  for specialists. Channel messages are the durable transcript.
- **Delegation.** The executive assistant has a `handoff` tool: it spawns a child
  turn in the same thread with a specialist persona, the child's answer posts back
  into the channel, and the executive assistant synthesizes a reply. A
  `create_agent` tool lets the executive assistant register new agents at runtime.
  Specialists are currently **hidden from the sidebar** but remain valid handoff
  targets.
- **Memory.** Durable stores: `agent_memories` (facts with scope/type/tags/
  importance), `links`, and `tasks`. Facts are recalled into the prompt prefix.
- **Compaction.** `rollover.ts` closes a full session block into a carried summary
  and opens a new one; `compactor.ts` compacts channel history.
- **Roster.** A static set of personas (the executive assistant plus hidden
  specialists) drives the sidebar and the handoff target list.

## 4. The problem to solve

- How to make **one interface** feel like a continuous conversation while the
  backend manages many sessions, threads, and agents.
- How the user experiences **"no sessions"** — they just chat; the system decides
  when to start, continue, compact, and pull context.
- How context is **pulled and combined** across agents and sessions without the
  user noticing.
- A **super-efficient memory management system** that supports all of the above.
- How the executive assistant **delegates, tracks, and synthesizes** work from
  specialist agents and keeps the user updated, while the user sees only one chat.

## 5. Research questions

Investigate and report on each of these. Prefer primary sources (papers, docs,
engineering blogs) and name the systems you looked at.

- **Context management for LLM agents.** Context windows; what to keep, summarize,
  and drop; hierarchical context; compaction strategies; when to compact; how to
  carry a summary forward; how to decide what to inject into a prompt.
- **Memory systems for agents.** Episodic / semantic / procedural memory for
  agents; retrieval-augmented memory; memory consolidation; importance and decay;
  how systems such as **MemGPT/Letta, Mem0, Zep/Graphiti**, and others structure
  agent memory, and what we can borrow.
- **Single-interface / multi-session UX.** How to present a continuous conversation
  while managing sessions behind the scenes; how existing products hide session
  boundaries from users.
- **Orchestration and delegation.** Patterns for a chief-of-staff agent that spawns
  and coordinates specialist agents; task routing; result aggregation; status
  updates to the user; how frameworks such as **AutoGen, CrewAI, LangGraph,
  OpenAI Swarm**, and similar structure multi-agent delegation.
- **Efficiency.** Minimizing token cost and latency across many agents and
  sessions; context sharing vs. isolation; caching; avoiding redundant work.
- **Competitive landscape.** What **Crockpot, Hermes, and OpenClaw** do for
  context, memory, and multi-agent coordination; where they fall short; and what we
  must build to surpass them.

## 6. Ambition

We aim to **surpass Crockpot, Hermes, and OpenClaw** by delivering a
single-interface, chief-of-staff product with super-efficient memory and
transparent background delegation. The research should identify what those
products do well, where the gaps are, and exactly what we must build to win.

## 7. Output format (required)

Produce **two artifacts**. Both must be specific and actionable — a design that
tells us exactly how to do context management for this product, not generic advice.

### A. Markdown document

A complete, self-contained design document covering:

- Executive summary of the recommended approach.
- The **context-management model**: sessions, compaction, and what the user sees
  vs. what the system does.
- The **memory system**: structure, storage, retrieval, consolidation, and
  efficiency.
- The **delegation/orchestration model**: chief-of-staff plus specialists, task
  routing, status updates, and result aggregation.
- A **concrete implementation plan** mapped onto Agni's current architecture
  (conversations, session blocks, channels, handoff, memory stores, rollover).
- Trade-offs, risks, and open questions.
- Competitive-analysis summary.

### B. HTML artifact

A single **self-contained HTML page** (no external requests, all CSS inline, works
offline) that presents the same design as a readable, navigable document suitable
for sharing. It must include:

- A clear **diagram** (rendered with HTML/CSS, no external libraries) of the flow:
  one chat interface → executive assistant → specialist agents, with context and
  memory moving between them.
- The context-management and memory models.
- The delegation/orchestration model.
- The implementation roadmap.
- Everything needed to understand and build the system.

---

## 8. Definition of done

The research is complete when both artifacts answer: given Agni's current
architecture, **exactly how do we build a single-interface, chief-of-staff system
with super-efficient memory and silent background delegation** — such that the user
chats with one bot like a friend, never sees a session boundary, and the system
handles everything else?
