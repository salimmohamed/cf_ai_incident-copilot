import { Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { getToolName, isToolUIPart, type UIMessage } from "ai";
import { Streamdown } from "streamdown";
import {
  ChatCircleDotsIcon,
  CircleIcon,
  ClockIcon,
  FileTextIcon,
  LightningIcon,
  PaperPlaneRightIcon,
  ShieldCheckIcon,
  SirenIcon,
  TrashIcon,
  WrenchIcon
} from "@phosphor-icons/react";
import type {
  IncidentActionItem,
  IncidentCopilotAgent,
  IncidentHypothesis,
  IncidentState,
  IncidentTimelineEntry
} from "./server";

const EXAMPLE_PROMPTS = [
  "Customers report 500s on checkout after the 14:05 deploy. Error rate is 18 percent and climbing.",
  "Mitigation update: we disabled the promo service dependency and latency dropped back to normal.",
  "Draft a short leadership update and tell me what to do next."
];

const FALLBACK_STATE: IncidentState = {
  title: "Checkout latency spike",
  service: "checkout-api",
  severity: "sev2",
  status: "triaging",
  summary: "Waiting for the first incident signal.",
  impact: "No customer impact recorded yet.",
  nextUpdate: "No update scheduled.",
  commander: "Unassigned",
  timeline: [],
  hypotheses: [],
  actionItems: [],
  postmortemDraft: "",
  lastUpdatedAt: new Date(0).toISOString()
};

function formatTimestamp(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
}

function formatLastUpdated(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime()) || date.getTime() === 0)
    return "Not updated yet";
  return `${formatTimestamp(iso)} local`;
}

function ToolEvent({ part }: { part: UIMessage["parts"][number] }) {
  if (!isToolUIPart(part)) return null;

  let label = "Running";
  if (part.state === "output-available") label = "Updated";
  if (part.state === "output-error") label = "Failed";

  return (
    <div className="tool-event">
      <div className="tool-event-head">
        <WrenchIcon size={14} weight="bold" />
        <span>{getToolName(part)}</span>
        <span className="tool-event-label">{label}</span>
      </div>
    </div>
  );
}

function MetricCard({
  label,
  value,
  icon
}: {
  label: string;
  value: string | number;
  icon: ReactNode;
}) {
  return (
    <div className="metric-card">
      <div className="metric-icon">{icon}</div>
      <div>
        <div className="metric-value">{value}</div>
        <div className="metric-label">{label}</div>
      </div>
    </div>
  );
}

function HypothesisList({ items }: { items: IncidentHypothesis[] }) {
  if (items.length === 0) {
    return (
      <p className="empty-copy">New root-cause theories will appear here.</p>
    );
  }

  return (
    <div className="stack-list">
      {items
        .slice()
        .reverse()
        .map((item) => (
          <div key={item.id} className="stack-card">
            <div className="stack-card-head">
              <span>{item.statement}</span>
              <span className={`mini-pill hypothesis-${item.status}`}>
                {item.status}
              </span>
            </div>
            <p>{item.evidence}</p>
            <div className="stack-card-foot">{item.confidence} confidence</div>
          </div>
        ))}
    </div>
  );
}

function ActionItems({ items }: { items: IncidentActionItem[] }) {
  if (items.length === 0) {
    return <p className="empty-copy">Operational next steps will land here.</p>;
  }

  return (
    <div className="stack-list">
      {items.map((item) => (
        <div key={item.id} className="stack-card">
          <div className="stack-card-head">
            <span>{item.title}</span>
            <span className={`mini-pill action-${item.status}`}>
              {item.priority}
            </span>
          </div>
          <p>
            {item.owner}
            {item.notes ? ` - ${item.notes}` : ""}
          </p>
          <div className="stack-card-foot">
            {item.status === "done" ? "Completed" : "Open"}
          </div>
        </div>
      ))}
    </div>
  );
}

function Timeline({ items }: { items: IncidentTimelineEntry[] }) {
  if (items.length === 0) {
    return (
      <p className="empty-copy">
        Timeline events will appear as the incident evolves.
      </p>
    );
  }

  return (
    <div className="timeline">
      {items
        .slice()
        .reverse()
        .map((item) => (
          <div key={item.id} className="timeline-row">
            <div className="timeline-time">
              {formatTimestamp(item.timestamp)}
            </div>
            <div className="timeline-dot" />
            <div>
              <div className="timeline-detail">{item.detail}</div>
              <div className="timeline-source">{item.source}</div>
            </div>
          </div>
        ))}
    </div>
  );
}

function Chat() {
  const [connected, setConnected] = useState(false);
  const [input, setInput] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [copiedDraft, setCopiedDraft] = useState(false);
  const [resetting, setResetting] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const agent = useAgent<IncidentCopilotAgent, IncidentState>({
    agent: "IncidentCopilotAgent",
    name: "primary",
    onOpen: () => setConnected(true),
    onClose: () => setConnected(false),
    onError: (error) => console.error("Socket error", error)
  });

  const { messages, sendMessage, clearHistory, stop, status } = useAgentChat({
    agent
  });

  const board = agent.state ?? FALLBACK_STATE;
  const openActions = board.actionItems.filter(
    (item) => item.status === "open"
  );
  const activeHypotheses = board.hypotheses.filter(
    (item) => item.status === "open"
  );
  const isStreaming = status === "streaming" || status === "submitted";

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (!isStreaming) {
      textareaRef.current?.focus();
    }
  }, [isStreaming]);

  async function handleSend() {
    const text = input.trim();
    if (!text || isStreaming) return;
    setInput("");
    sendMessage({
      role: "user",
      parts: [{ type: "text", text }]
    });
  }

  async function handleReset() {
    setResetting(true);
    try {
      clearHistory();
      await agent.stub.resetIncident();
      setInput("");
    } finally {
      setResetting(false);
    }
  }

  async function handleDraftPostmortem() {
    setDrafting(true);
    try {
      await agent.stub.draftPostmortem();
    } finally {
      setDrafting(false);
    }
  }

  async function handleCopyDraft() {
    if (!board.postmortemDraft) return;
    await navigator.clipboard.writeText(board.postmortemDraft);
    setCopiedDraft(true);
    window.setTimeout(() => setCopiedDraft(false), 1500);
  }

  return (
    <div className="shell">
      <div className="page-grid">
        <aside className="rail">
          <section className="panel hero-panel">
            <div className="eyebrow">Cloudflare Agents demo app</div>
            <h1>Incident Copilot</h1>
            <p className="hero-copy">
              A stateful incident room that turns free-form chat into a live ops
              board, action queue, and postmortem draft.
            </p>
            <div className="hero-meta">
              <span className="connection">
                <CircleIcon
                  size={10}
                  weight="fill"
                  className={connected ? "connected" : "disconnected"}
                />
                {connected ? "Connected" : "Connecting"}
              </span>
            </div>
          </section>

          <section className="metrics-grid">
            <MetricCard
              label="Open actions"
              value={openActions.length}
              icon={<LightningIcon size={18} />}
            />
            <MetricCard
              label="Active hypotheses"
              value={activeHypotheses.length}
              icon={<SirenIcon size={18} />}
            />
            <MetricCard
              label="Last updated"
              value={formatLastUpdated(board.lastUpdatedAt)}
              icon={<ClockIcon size={18} />}
            />
          </section>

          <section className="panel">
            <div className="section-head">
              <h2>Incident board</h2>
              <span className="mini-pill subtle">Durable Object state</span>
            </div>
            <dl className="board-grid">
              <div>
                <dt>Title</dt>
                <dd>{board.title}</dd>
              </div>
              <div>
                <dt>Service</dt>
                <dd>{board.service}</dd>
              </div>
              <div>
                <dt>Commander</dt>
                <dd>{board.commander}</dd>
              </div>
              <div>
                <dt>Next update</dt>
                <dd>{board.nextUpdate}</dd>
              </div>
            </dl>
            <div className="board-copy">
              <div>
                <span>Summary</span>
                <p>{board.summary}</p>
              </div>
              <div>
                <span>Impact</span>
                <p>{board.impact}</p>
              </div>
            </div>
          </section>

          <section className="panel">
            <div className="section-head">
              <h2>Root-cause hypotheses</h2>
              <span className="mini-pill">{board.hypotheses.length}</span>
            </div>
            <HypothesisList items={board.hypotheses} />
          </section>

          <section className="panel">
            <div className="section-head">
              <h2>Action queue</h2>
              <span className="mini-pill">{board.actionItems.length}</span>
            </div>
            <ActionItems items={board.actionItems} />
          </section>

          <section className="panel">
            <div className="section-head">
              <h2>Timeline</h2>
              <span className="mini-pill">{board.timeline.length}</span>
            </div>
            <Timeline items={board.timeline} />
          </section>

          <section className="panel">
            <div className="section-head">
              <h2>Postmortem draft</h2>
              <div className="inline-actions">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={handleDraftPostmortem}
                  disabled={!connected || drafting}
                >
                  <FileTextIcon size={15} />
                  {drafting ? "Drafting..." : "Refresh"}
                </button>
                <button
                  type="button"
                  className="ghost-button"
                  onClick={handleCopyDraft}
                  disabled={!board.postmortemDraft}
                >
                  {copiedDraft ? "Copied" : "Copy"}
                </button>
              </div>
            </div>
            {board.postmortemDraft ? (
              <div className="draft-panel">
                <Streamdown controls={false}>
                  {board.postmortemDraft}
                </Streamdown>
              </div>
            ) : (
              <p className="empty-copy">
                Generate a draft after a few chat turns and incident updates.
              </p>
            )}
          </section>
        </aside>

        <main className="main-column">
          <section className="panel main-panel">
            <div className="chat-header">
              <div>
                <div className="eyebrow">Realtime operator chat</div>
                <h2>Work the incident in plain language</h2>
              </div>
              <div className="inline-actions">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={handleDraftPostmortem}
                  disabled={!connected || drafting}
                >
                  <ShieldCheckIcon size={15} />
                  {drafting ? "Drafting..." : "Build postmortem"}
                </button>
                <button
                  type="button"
                  className="ghost-button"
                  onClick={handleReset}
                  disabled={resetting}
                >
                  <TrashIcon size={15} />
                  {resetting ? "Resetting..." : "Reset room"}
                </button>
              </div>
            </div>

            <div className="quick-prompts">
              {EXAMPLE_PROMPTS.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  className="prompt-chip"
                  disabled={isStreaming}
                  onClick={() => {
                    setInput(prompt);
                    textareaRef.current?.focus();
                  }}
                >
                  {prompt}
                </button>
              ))}
            </div>

            <div className="message-stack">
              {messages.length === 0 ? (
                <div className="empty-state">
                  <ChatCircleDotsIcon size={30} />
                  <h3>Start the war room</h3>
                  <p>
                    Describe symptoms, metrics, what changed, or who is
                    affected. The agent will keep the incident board in sync as
                    you chat.
                  </p>
                </div>
              ) : (
                messages.map((message, index) => {
                  const isUser = message.role === "user";
                  const isLastAssistant =
                    message.role === "assistant" &&
                    index === messages.length - 1;

                  return (
                    <article
                      key={message.id}
                      className={`message-row ${isUser ? "user-row" : "assistant-row"}`}
                    >
                      <div
                        className={`message-bubble ${isUser ? "user-bubble" : "assistant-bubble"}`}
                      >
                        <div className="message-role">
                          {isUser ? "Operator" : "Incident Copilot"}
                        </div>

                        {message.parts.filter(isToolUIPart).map((part) => (
                          <ToolEvent key={part.toolCallId} part={part} />
                        ))}

                        {message.parts
                          .filter((part) => part.type === "text")
                          .map((part, partIndex) => {
                            const text = (
                              part as { type: "text"; text: string }
                            ).text;
                            if (!text) return null;

                            return isUser ? (
                              <p key={partIndex} className="plain-message">
                                {text}
                              </p>
                            ) : (
                              <div key={partIndex} className="markdown-message">
                                <Streamdown
                                  controls={false}
                                  isAnimating={isLastAssistant && isStreaming}
                                >
                                  {text}
                                </Streamdown>
                              </div>
                            );
                          })}
                      </div>
                    </article>
                  );
                })
              )}
              <div ref={messagesEndRef} />
            </div>

            <form
              className="composer"
              onSubmit={(event) => {
                event.preventDefault();
                handleSend();
              }}
            >
              <textarea
                ref={textareaRef}
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    handleSend();
                  }
                }}
                placeholder="Describe the latest signal, mitigation, or question..."
                rows={3}
                disabled={!connected || isStreaming}
              />
              <div className="composer-actions">
                <div className="composer-note">
                  Live state updates are stored in the agent, not just the chat
                  transcript.
                </div>
                <div className="inline-actions">
                  {isStreaming ? (
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={stop}
                    >
                      Stop
                    </button>
                  ) : null}
                  <button
                    type="submit"
                    className="primary-button"
                    disabled={!connected || !input.trim()}
                  >
                    <PaperPlaneRightIcon size={15} />
                    Send update
                  </button>
                </div>
              </div>
            </form>
          </section>
        </main>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <Suspense
      fallback={<div className="loading-screen">Loading incident room...</div>}
    >
      <Chat />
    </Suspense>
  );
}
