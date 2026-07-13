import { expect, test } from "vitest";

import {
  AgentSnapshotPayloadSchema,
  type AgentSnapshotPayload,
  type SessionOutboundMessage,
} from "@getpaseo/protocol/messages";
import type {
  HubAgentCreateInput,
  HubExecutions,
  OwnedAgentEvent,
  OwnedAgentSnapshot,
} from "./relationship-owned-executions.js";
import { HubSession } from "./hub-session.js";

class InMemoryHubExecutions implements HubExecutions {
  private readonly listeners = new Set<(event: OwnedAgentEvent) => void>();
  private reconcileError: Error | null = null;

  async create(_input: HubAgentCreateInput): Promise<OwnedAgentSnapshot> {
    return { executionId: "execution-1", agent: createAgentSnapshot() };
  }

  async reconcile(_executionId: string): Promise<OwnedAgentSnapshot | null> {
    if (this.reconcileError) throw this.reconcileError;
    return { executionId: "execution-1", agent: createAgentSnapshot() };
  }

  subscribe(listener: (event: OwnedAgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publishCurrentState(): void {
    for (const listener of this.listeners) {
      listener({ type: "update", executionId: "execution-1", agent: createAgentSnapshot() });
    }
  }

  failReconcile(error: Error): void {
    this.reconcileError = error;
  }
}

class HubSessionBoundary {
  private readonly executions = new InMemoryHubExecutions();
  private readonly messages: SessionOutboundMessage[] = [];
  private readonly session = new HubSession({
    executions: this.executions,
    send: (message) => this.messages.push(message),
  });

  publishCurrentState(): void {
    this.executions.publishCurrentState();
  }

  disconnect(): void {
    this.session.cleanup();
  }

  async failReconcile(): Promise<void> {
    this.executions.failReconcile(new Error("storage unavailable"));
    await this.session.handleMessage({
      type: "hub.execution.reconcile.request",
      requestId: "reconcile-1",
      executionId: "execution-1",
    });
  }

  deliveredMessages(): SessionOutboundMessage[] {
    return this.messages.slice();
  }

  deliveredTypes(): string[] {
    return this.messages.map((message) => message.type);
  }
}

test("disconnect unsubscribes Hub from later owned-agent updates", () => {
  const hub = new HubSessionBoundary();

  hub.publishCurrentState();
  hub.disconnect();
  hub.publishCurrentState();

  expect(hub.deliveredTypes()).toEqual(["hub.agent.update"]);
});

test("reconcile storage failures receive a terminal empty response", async () => {
  const hub = new HubSessionBoundary();

  await hub.failReconcile();

  expect(hub.deliveredMessages()).toEqual([
    {
      type: "hub.execution.reconcile.response",
      payload: {
        requestId: "reconcile-1",
        executionId: "execution-1",
        agentId: null,
        agent: null,
      },
    },
  ]);
});

function createAgentSnapshot(): AgentSnapshotPayload {
  return AgentSnapshotPayloadSchema.parse({
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
  });
}
