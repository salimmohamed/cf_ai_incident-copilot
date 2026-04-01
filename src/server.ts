import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import { callable, routeAgentRequest } from "agents";
import {
  convertToModelMessages,
  generateText,
  pruneMessages,
  stepCountIs,
  streamText,
  tool
} from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { z } from "zod";

const CHAT_MODEL_NAME = "@cf/zai-org/glm-4.7-flash";
const DRAFT_MODEL_NAME = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

const severityValues = ["sev1", "sev2", "sev3", "monitoring"] as const;
const statusValues = [
  "triaging",
  "investigating",
  "mitigated",
  "resolved"
] as const;
const confidenceValues = ["low", "medium", "high"] as const;
const hypothesisStatusValues = ["open", "confirmed", "discarded"] as const;
const actionPriorityValues = ["p1", "p2", "p3"] as const;
const actionStatusValues = ["open", "done"] as const;

export type IncidentSeverity = (typeof severityValues)[number];
export type IncidentStatus = (typeof statusValues)[number];
export type HypothesisConfidence = (typeof confidenceValues)[number];
export type HypothesisStatus = (typeof hypothesisStatusValues)[number];
export type ActionPriority = (typeof actionPriorityValues)[number];
export type ActionStatus = (typeof actionStatusValues)[number];

export interface IncidentTimelineEntry {
  id: string;
  timestamp: string;
  detail: string;
  source: string;
}

export interface IncidentHypothesis {
  id: string;
  statement: string;
  confidence: HypothesisConfidence;
  evidence: string;
  status: HypothesisStatus;
}

export interface IncidentActionItem {
  id: string;
  title: string;
  owner: string;
  priority: ActionPriority;
  status: ActionStatus;
  notes: string;
}

export interface IncidentState {
  title: string;
  service: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
  summary: string;
  impact: string;
  nextUpdate: string;
  commander: string;
  timeline: IncidentTimelineEntry[];
  hypotheses: IncidentHypothesis[];
  actionItems: IncidentActionItem[];
  postmortemDraft: string;
  lastUpdatedAt: string;
}

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix: string) {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function createInitialIncidentState(): IncidentState {
  return {
    title: "Checkout latency spike",
    service: "checkout-api",
    severity: "sev2",
    status: "triaging",
    summary:
      "Use the chat to describe symptoms, what changed, and mitigation steps. The incident board updates live as the agent learns.",
    impact: "No customer impact recorded yet.",
    nextUpdate: "No update scheduled.",
    commander: "Unassigned",
    timeline: [
      {
        id: makeId("timeline"),
        timestamp: nowIso(),
        detail: "Incident room created. Waiting for the first signal.",
        source: "system"
      }
    ],
    hypotheses: [],
    actionItems: [],
    postmortemDraft: "",
    lastUpdatedAt: nowIso()
  };
}

function touchState(state: IncidentState): IncidentState {
  return {
    ...state,
    lastUpdatedAt: nowIso()
  };
}

function trimRecent<T>(items: T[], limit: number): T[] {
  return items.slice(-limit);
}

function formatBoard(state: IncidentState) {
  return JSON.stringify(state, null, 2);
}

export class IncidentCopilotAgent extends AIChatAgent<Env, IncidentState> {
  maxPersistedMessages = 120;

  onStart() {
    if (!this.state?.timeline) {
      this.setState(createInitialIncidentState());
    }
  }

  private get board(): IncidentState {
    return this.state ?? createInitialIncidentState();
  }

  @callable()
  async resetIncident() {
    const next = createInitialIncidentState();
    this.setState(next);
    return next;
  }

  @callable()
  async draftPostmortem() {
    const workersai = createWorkersAI({ binding: this.env.AI });
    const transcript = await convertToModelMessages(this.messages);
    const result = await generateText({
      model: workersai(DRAFT_MODEL_NAME, {
        sessionAffinity: this.sessionAffinity
      }),
      system: `You are writing a crisp postmortem draft for engineering leadership.
Return Markdown with these sections exactly:
- Title
- Customer Impact
- Timeline
- Root Cause Hypotheses
- Mitigation and Recovery
- Follow-up Actions

Stay grounded in the source material. If details are unknown, say so plainly.`,
      prompt: `Incident board:
${formatBoard(this.board)}

Chat transcript:
${JSON.stringify(transcript, null, 2)}`
    });

    const next = touchState({
      ...this.board,
      postmortemDraft: result.text
    });
    this.setState(next);
    return result.text;
  }

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const workersai = createWorkersAI({ binding: this.env.AI });

    const result = streamText({
      model: workersai(CHAT_MODEL_NAME, {
        sessionAffinity: this.sessionAffinity
      }),
      system: `You are Incident Copilot, an incident commander assistant for production outages.

Your job is to help the operator triage the incident while keeping the live incident board current.

Rules:
1. Any time the user gives new factual information, update the board with one or more tools before replying.
2. Keep responses concise and operational. Prefer bullets or short paragraphs over long essays.
3. When information is missing, ask the next best clarifying question.
4. Use the draftStatusUpdate tool when the user wants a stakeholder or leadership update.
5. Do not invent facts. If a root cause is uncertain, keep it as a hypothesis.
6. Never print raw JSON, pseudo-function calls, or tool arguments in your final user-facing reply.
7. The runtime already gives you tool access. Call tools directly instead of describing the call.

Current incident board:
${formatBoard(this.board)}`,
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: "before-last-4-messages"
      }),
      tools: {
        updateIncidentOverview: tool({
          description:
            "Update high-level incident fields after new facts arrive, such as severity, status, impact, summary, or commander.",
          inputSchema: z.object({
            title: z.string().optional(),
            service: z.string().optional(),
            severity: z.enum(severityValues).optional(),
            status: z.enum(statusValues).optional(),
            summary: z.string().optional(),
            impact: z.string().optional(),
            nextUpdate: z.string().optional(),
            commander: z.string().optional()
          }),
          execute: async (input) => {
            const next = touchState({
              ...this.board,
              ...Object.fromEntries(
                Object.entries(input).filter(([, value]) => value !== undefined)
              )
            });
            this.setState(next);
            return next;
          }
        }),
        addTimelineEntry: tool({
          description:
            "Log a concrete timeline event such as detection, mitigation, rollback, recovery, or a meaningful symptom.",
          inputSchema: z.object({
            detail: z.string().describe("What happened"),
            source: z.string().describe("Who or what reported it"),
            timestamp: z.string().optional()
          }),
          execute: async ({ detail, source, timestamp }) => {
            const entry: IncidentTimelineEntry = {
              id: makeId("timeline"),
              timestamp: timestamp || nowIso(),
              detail,
              source
            };
            const next = touchState({
              ...this.board,
              timeline: trimRecent([...this.board.timeline, entry], 30)
            });
            this.setState(next);
            return entry;
          }
        }),
        addHypothesis: tool({
          description:
            "Capture a possible root cause or contributing factor, along with evidence and confidence.",
          inputSchema: z.object({
            statement: z.string(),
            evidence: z.string(),
            confidence: z.enum(confidenceValues)
          }),
          execute: async ({ statement, evidence, confidence }) => {
            const item: IncidentHypothesis = {
              id: makeId("hyp"),
              statement,
              evidence,
              confidence,
              status: "open"
            };
            const next = touchState({
              ...this.board,
              hypotheses: trimRecent([...this.board.hypotheses, item], 12)
            });
            this.setState(next);
            return item;
          }
        }),
        updateHypothesisStatus: tool({
          description:
            "Confirm or discard an existing hypothesis as evidence changes.",
          inputSchema: z.object({
            id: z.string(),
            status: z.enum(hypothesisStatusValues)
          }),
          execute: async ({ id, status }) => {
            const next = touchState({
              ...this.board,
              hypotheses: this.board.hypotheses.map((item) =>
                item.id === id ? { ...item, status } : item
              )
            });
            this.setState(next);
            return next.hypotheses.find((item) => item.id === id) ?? null;
          }
        }),
        addActionItem: tool({
          description:
            "Track an operational next step such as checking dashboards, rolling back a deploy, or contacting an owner.",
          inputSchema: z.object({
            title: z.string(),
            owner: z.string(),
            priority: z.enum(actionPriorityValues),
            notes: z.string().optional()
          }),
          execute: async ({ title, owner, priority, notes }) => {
            const item: IncidentActionItem = {
              id: makeId("todo"),
              title,
              owner,
              priority,
              status: "open",
              notes: notes || ""
            };
            const next = touchState({
              ...this.board,
              actionItems: trimRecent([...this.board.actionItems, item], 20)
            });
            this.setState(next);
            return item;
          }
        }),
        resolveActionItem: tool({
          description:
            "Mark an action item as completed when it has been done.",
          inputSchema: z.object({
            id: z.string(),
            notes: z.string().optional()
          }),
          execute: async ({ id, notes }) => {
            const next = touchState({
              ...this.board,
              actionItems: this.board.actionItems.map((item) =>
                item.id === id
                  ? {
                      ...item,
                      status: "done",
                      notes: notes || item.notes
                    }
                  : item
              )
            });
            this.setState(next);
            return next.actionItems.find((item) => item.id === id) ?? null;
          }
        }),
        draftStatusUpdate: tool({
          description:
            "Generate a short stakeholder-ready update based on the current incident board.",
          inputSchema: z.object({
            audience: z
              .enum(["engineering", "leadership", "customers"])
              .describe("Who the update is for")
          }),
          execute: async ({ audience }) => {
            const openItems = this.board.actionItems.filter(
              (item) => item.status === "open"
            );
            return `Audience: ${audience}
Status: ${this.board.status}
Severity: ${this.board.severity}
Service: ${this.board.service}
Summary: ${this.board.summary}
Impact: ${this.board.impact}
Next update: ${this.board.nextUpdate}
Open actions: ${
              openItems.length > 0
                ? openItems
                    .map((item) => `${item.owner}: ${item.title}`)
                    .join("; ")
                : "none recorded"
            }`;
          }
        })
      },
      stopWhen: stepCountIs(8),
      abortSignal: options?.abortSignal
    });

    return result.toUIMessageStreamResponse();
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
