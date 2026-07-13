import type {
  HubAgentCreateRequest,
  HubExecutionReconcileRequest,
  SessionInboundMessage,
  SessionOutboundMessage,
} from "@getpaseo/protocol/messages";

import type { HubExecutions, OwnedAgentEvent } from "./relationship-owned-executions.js";

interface HubSessionOptions {
  executions: HubExecutions;
  send: (message: SessionOutboundMessage) => void;
}

export class HubSession {
  private readonly executions: HubExecutions;
  private readonly send: (message: SessionOutboundMessage) => void;
  private readonly unsubscribe: () => void;

  constructor(options: HubSessionOptions) {
    this.executions = options.executions;
    this.send = options.send;
    this.unsubscribe = this.executions.subscribe((event) => this.sendOwnedEvent(event));
  }

  async handleMessage(message: SessionInboundMessage): Promise<void> {
    if (message.type === "hub.agent.create.request") {
      await this.createAgent(message);
      return;
    }
    if (message.type === "hub.execution.reconcile.request") {
      await this.reconcile(message);
      return;
    }
    const requestId = requestIdForMessage(message);
    this.send({
      type: "hub.authorization.denied",
      payload: {
        ...(requestId ? { requestId } : {}),
        requestType: message.type,
        code: "scope_denied",
      },
    });
  }

  cleanup(): void {
    this.unsubscribe();
  }

  private async createAgent(message: HubAgentCreateRequest): Promise<void> {
    try {
      const result = await this.executions.create({
        executionId: message.executionId,
        provider: message.provider,
        cwd: message.cwd,
        workspaceId: message.workspaceId,
        prompt: message.prompt,
        model: message.model,
        modeId: message.modeId,
        thinkingOptionId: message.thinkingOptionId,
        featureValues: message.featureValues,
        env: message.env,
        worktree: message.worktree,
        autoArchive: message.autoArchive,
      });
      this.send({
        type: "hub.agent.create.response",
        payload: {
          requestId: message.requestId,
          executionId: message.executionId,
          agentId: result.agent.id,
          agent: result.agent,
          success: true,
          error: null,
        },
      });
    } catch (error) {
      this.send({
        type: "hub.agent.create.response",
        payload: {
          requestId: message.requestId,
          executionId: message.executionId,
          agentId: null,
          agent: null,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private async reconcile(message: HubExecutionReconcileRequest): Promise<void> {
    let result: Awaited<ReturnType<HubExecutions["reconcile"]>> = null;
    try {
      result = await this.executions.reconcile(message.executionId);
    } catch {
      // Reconcile has no error variant on the wire. A terminal empty response
      // lets Hub stop waiting and decide whether to replay the execution.
    }
    this.send({
      type: "hub.execution.reconcile.response",
      payload: {
        requestId: message.requestId,
        executionId: message.executionId,
        agentId: result?.agent.id ?? null,
        agent: result?.agent ?? null,
      },
    });
  }

  private sendOwnedEvent(event: OwnedAgentEvent): void {
    if (event.type === "update") {
      this.send({
        type: "hub.agent.update",
        payload: {
          executionId: event.executionId,
          agentId: event.agent.id,
          agent: event.agent,
        },
      });
      return;
    }
    this.send({
      type: "hub.agent.stream",
      payload: {
        executionId: event.executionId,
        agentId: event.agentId,
        event: event.event,
      },
    });
  }
}

function requestIdForMessage(message: SessionInboundMessage): string | undefined {
  if ("requestId" in message && typeof message.requestId === "string") {
    return message.requestId;
  }
  if (
    "payload" in message &&
    typeof message.payload === "object" &&
    message.payload !== null &&
    "requestId" in message.payload &&
    typeof message.payload.requestId === "string"
  ) {
    return message.payload.requestId;
  }
  return undefined;
}
