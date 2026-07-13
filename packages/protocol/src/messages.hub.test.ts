import { describe, expect, test } from "vitest";
import { z } from "zod";

import {
  HubMessageCorrelationError,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
  parseHubSessionOutboundMessage,
} from "./messages.js";

const agent = {
  id: "agent-1",
  provider: "codex",
  cwd: "/workspace",
  model: null,
  createdAt: "2026-07-13T00:00:00.000Z",
  updatedAt: "2026-07-13T00:00:00.000Z",
  lastUserMessageAt: null,
  status: "idle",
  capabilities: {
    supportsStreaming: true,
    supportsSessionPersistence: true,
    supportsDynamicModes: true,
    supportsMcpServers: false,
    supportsReasoningStream: true,
    supportsToolInvocations: true,
    supportsRewindConversation: false,
    supportsRewindFiles: false,
    supportsRewindBoth: false,
  },
  currentModeId: null,
  availableModes: [],
  pendingPermissions: [],
  persistence: null,
  title: null,
  labels: {},
};

// Frozen at the Hub create request shape shipped before worktree and autoArchive.
const PreviousHubAgentCreateRequestSchema = z.object({
  type: z.literal("hub.agent.create.request"),
  requestId: z.string(),
  executionId: z.string(),
  provider: z.string(),
  cwd: z.string(),
  workspaceId: z.string().optional(),
  prompt: z.string(),
  model: z.string().optional(),
  modeId: z.string().optional(),
  thinkingOptionId: z.string().optional(),
  featureValues: z.record(z.string(), z.unknown()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});

describe("Hub session protocol", () => {
  test.each([
    {
      type: "hub.agent.create.request",
      requestId: "request-1",
      executionId: "execution-1",
      provider: "codex",
      cwd: "/workspace",
      prompt: "Implement the requested change",
      modeId: "code",
    },
    {
      type: "hub.execution.reconcile.request",
      requestId: "request-2",
      executionId: "execution-1",
    },
  ])("accepts inbound variant $type", (message) => {
    expect(SessionInboundMessageSchema.parse(message)).toEqual(message);
  });

  test.each([
    undefined,
    { mode: "branch-off", newBranch: "hub-work", base: "main" },
    { mode: "checkout-branch", branch: "existing-work" },
    { mode: "checkout-pr", prNumber: 42 },
  ])("accepts Hub create worktree target %#", (worktree) => {
    const message = {
      type: "hub.agent.create.request",
      requestId: "hub-worktree",
      executionId: "execution-worktree",
      provider: "codex",
      cwd: "/repo",
      prompt: "Work in the requested target",
      ...(worktree ? { worktree, autoArchive: true } : {}),
    };

    expect(SessionInboundMessageSchema.parse(message)).toEqual(message);
  });

  test("the previous Hub create parser ignores additive worktree and auto-archive fields", () => {
    const newRequest = {
      type: "hub.agent.create.request" as const,
      requestId: "hub-worktree",
      executionId: "execution-worktree",
      provider: "codex",
      cwd: "/repo",
      prompt: "Work in the requested target",
      worktree: { mode: "branch-off", newBranch: "hub-work", base: "main" },
      autoArchive: true,
    };

    expect(PreviousHubAgentCreateRequestSchema.parse(newRequest)).toEqual({
      type: "hub.agent.create.request",
      requestId: "hub-worktree",
      executionId: "execution-worktree",
      provider: "codex",
      cwd: "/repo",
      prompt: "Work in the requested target",
    });
  });

  test.each([
    {
      type: "hub.agent.create.response",
      payload: {
        requestId: "request-1",
        executionId: "execution-1",
        agentId: "agent-1",
        agent,
        success: true,
        error: null,
      },
    },
    {
      type: "hub.agent.update",
      payload: { executionId: "execution-1", agentId: "agent-1", agent },
    },
    {
      type: "hub.agent.stream",
      payload: {
        executionId: "execution-1",
        agentId: "agent-1",
        event: { type: "turn_started", provider: "codex" },
      },
    },
    {
      type: "hub.execution.reconcile.response",
      payload: {
        requestId: "request-2",
        executionId: "execution-1",
        agentId: "agent-1",
        agent,
      },
    },
    {
      type: "hub.authorization.denied",
      payload: {
        requestId: "request-3",
        requestType: "daemon.get_status.request",
        code: "scope_denied",
      },
    },
  ])("accepts outbound variant $type", (message) => {
    expect(SessionOutboundMessageSchema.parse(message)).toEqual(message);
    expect(parseHubSessionOutboundMessage(message)).toEqual(message);
  });

  test("rejects a Hub update whose correlated agent ids disagree", () => {
    const malformed = {
      type: "hub.agent.update",
      payload: { executionId: "execution-1", agentId: "agent-2", agent },
    };

    expect(SessionOutboundMessageSchema.safeParse(malformed).success).toBe(true);
    expect(() => parseHubSessionOutboundMessage(malformed)).toThrow(HubMessageCorrelationError);
  });

  test.each([
    {
      type: "hub.relationship.connect.request",
      requestId: "r1",
      hubUrl: "https://hub.example",
      token: "token",
    },
    { type: "hub.relationship.get_status.request", requestId: "r2" },
    { type: "hub.relationship.disconnect.request", requestId: "r3", force: true },
  ])("accepts trusted management request $type", (message) => {
    expect(SessionInboundMessageSchema.parse(message)).toEqual(message);
  });

  test.each([
    {
      type: "hub.relationship.connect.response",
      payload: {
        requestId: "r1",
        status: {
          state: "connected",
          relationshipId: "rel",
          hubOrigin: "https://hub.example",
          scopes: ["hub.*"],
          connectedAt: "2026-07-13T00:00:00.000Z",
          lastError: null,
        },
      },
    },
    {
      type: "hub.relationship.get_status.response",
      payload: {
        requestId: "r2",
        status: {
          state: "not_connected",
          relationshipId: null,
          hubOrigin: null,
          scopes: [],
          connectedAt: null,
          lastError: null,
        },
      },
    },
    {
      type: "hub.relationship.disconnect.response",
      payload: {
        requestId: "r3",
        status: {
          state: "disconnecting",
          relationshipId: "rel",
          hubOrigin: "https://hub.example",
          scopes: ["hub.*"],
          connectedAt: null,
          lastError: "offline",
        },
        warning: "pending",
      },
    },
  ])("accepts trusted management response $type", (message) => {
    expect(SessionOutboundMessageSchema.parse(message)).toEqual(message);
  });
});
