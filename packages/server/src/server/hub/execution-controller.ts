import { isAbsolute } from "node:path";
import type {
  HubExecutionAgentCreateRequest,
  SessionOutboundMessage,
} from "@getpaseo/protocol/messages";

import type { HubExecutionAgents, OwnedAgentEvent } from "./daemon-executions.js";

interface HubExecutionControllerOptions {
  agents: HubExecutionAgents;
  send: (message: SessionOutboundMessage) => void;
}

export class HubExecutionController {
  private readonly agents: HubExecutionAgents;
  private readonly send: (message: SessionOutboundMessage) => void;
  private readonly unsubscribe: () => void;

  constructor(options: HubExecutionControllerOptions) {
    this.agents = options.agents;
    this.send = options.send;
    this.unsubscribe = this.agents.subscribe((event) => this.sendOwnedEvent(event));
  }

  cleanup(): void {
    this.unsubscribe();
  }

  async createAgent(message: HubExecutionAgentCreateRequest): Promise<void> {
    try {
      requireNonBlankHubAgentField("executionId", message.executionId);
      requireNonBlankHubAgentField("prompt", message.prompt);
      requireNonBlankHubAgentField("cwd", message.cwd);
      if (!isAbsolute(message.cwd)) throw new Error("Hub agent cwd must be absolute");
      const result = await this.agents.create({
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
        type: "hub.execution.agent.create.response",
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
        type: "hub.execution.agent.create.response",
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

  private sendOwnedEvent(event: OwnedAgentEvent): void {
    if (event.type === "update") {
      this.send({
        type: "hub.execution.agent.update",
        payload: {
          executionId: event.executionId,
          agentId: event.agent.id,
          agent: event.agent,
        },
      });
      return;
    }
    this.send({
      type: "hub.execution.agent.stream",
      payload: {
        executionId: event.executionId,
        agentId: event.agentId,
        event: event.event,
      },
    });
  }
}

function requireNonBlankHubAgentField(
  field: "executionId" | "prompt" | "cwd",
  value: string,
): void {
  if (value.trim().length === 0) {
    throw new Error(`Hub agent ${field} cannot be blank`);
  }
}
