import { z } from "zod";

export const AgentOwnerSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("hub"),
    relationshipId: z.string(),
    executionId: z.string(),
  }),
]);

export type AgentOwner = z.infer<typeof AgentOwnerSchema>;
export type HubAgentOwner = Extract<AgentOwner, { kind: "hub" }>;

export function hubExecutionKey(owner: HubAgentOwner): string {
  return `${owner.relationshipId}\0${owner.executionId}`;
}
