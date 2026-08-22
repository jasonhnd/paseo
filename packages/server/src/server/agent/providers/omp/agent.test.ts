import { afterEach, describe, expect, test } from "vitest";
import { setImmediate as waitForImmediate, setTimeout as delay } from "node:timers/promises";

import type { PaseoToolCatalog } from "../../tools/types.js";
import type {
  OmpNoTurnScheduler,
  OmpProviderIdleAttempt,
  OmpProviderIdleDecision,
  OmpProviderIdleScheduler,
} from "./agent.js";
import { createOmpProviderIdleScheduler } from "./agent.js";
import type { OmpUsagePollScheduler } from "./usage-poller.js";
import { OmpHarness } from "./test-utils/omp-harness.js";

function lastToolCallStatus(omp: OmpHarness, callId: string): string | undefined {
  const items = omp
    .timeline()
    .filter((item) => item.type === "tool_call" && item.callId === callId);
  const last = items[items.length - 1];
  return last?.type === "tool_call" ? last.status : undefined;
}

// Every ManualIdleScheduler registers here so a poll after the gate was
// abandoned fails the test that caused it. Throwing cannot: the gate's promise
// is consumed by a `.catch()` at the agent_end call site, so a throw would stop
// the runaway loop silently and the test would still pass.
const manualIdleSchedulers: ManualIdleScheduler[] = [];

afterEach(() => {
  const violations = manualIdleSchedulers.flatMap((scheduler) => scheduler.violations());
  manualIdleSchedulers.length = 0;
  expect(violations).toEqual([]);
});

class ManualIdleScheduler implements OmpProviderIdleScheduler {
  private readonly retries: Array<() => void> = [];
  private readonly waiters: Array<{ count: number; resolve: () => void }> = [];
  private readonly seen: OmpProviderIdleAttempt[] = [];
  private readonly abandonedPolls: string[] = [];
  private waitCount = 0;
  private abandoned = false;

  constructor(
    private readonly decide: (attempt: OmpProviderIdleAttempt) => OmpProviderIdleDecision = () => ({
      retry: true,
    }),
  ) {
    manualIdleSchedulers.push(this);
  }

  waitForRetry(attempt: OmpProviderIdleAttempt): Promise<OmpProviderIdleDecision> {
    if (this.abandoned) {
      // Recorded, not thrown, and counted before waitCount moves: a violating
      // poll must not satisfy a waitForWaits() a test is blocked on. Denying
      // again stops the loop instead of spinning with no timer.
      // Capped: a runaway loop must report through afterEach rather than
      // exhausting the worker before the assertion runs.
      if (this.abandonedPolls.length < 8) {
        this.abandonedPolls.push(
          `OMP polled again after the idle scheduler abandoned the gate (attempt ${attempt.attempt})`,
        );
      }
      return Promise.resolve({ retry: false, reason: "wait_budget" });
    }
    this.waitCount += 1;
    this.seen.push(attempt);
    for (const waiter of this.waiters.splice(0)) {
      if (this.waitCount >= waiter.count) waiter.resolve();
      else this.waiters.push(waiter);
    }
    const decision = this.decide(attempt);
    if (!decision.retry) {
      this.abandoned = true;
      return Promise.resolve(decision);
    }
    return new Promise((resolve) => this.retries.push(() => resolve(decision)));
  }

  violations(): string[] {
    return this.abandonedPolls;
  }

  attempts(): OmpProviderIdleAttempt[] {
    return this.seen;
  }

  waitForWaits(count: number): Promise<void> {
    if (this.waitCount >= count) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push({ count, resolve }));
  }

  retry(): void {
    const resolve = this.retries.shift();
    if (!resolve) throw new Error("OMP has not requested an idle-state retry");
    resolve();
  }

  retryAll(): void {
    for (const resolve of this.retries.splice(0)) resolve();
  }
}

class ManualNoTurnScheduler implements OmpNoTurnScheduler {
  private settleResolve: (() => void) | null = null;
  private aborted = false;

  waitForSettle(signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      this.aborted = true;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.settleResolve = resolve;
      signal.addEventListener(
        "abort",
        () => {
          this.aborted = true;
          this.settleResolve = null;
          resolve();
        },
        { once: true },
      );
    });
  }

  settle(): void {
    const resolve = this.settleResolve;
    if (!resolve) throw new Error("OMP has not requested a no-turn settle wait");
    this.settleResolve = null;
    resolve();
  }

  wasAborted(): boolean {
    return this.aborted;
  }
}

class ManualUsagePollScheduler implements OmpUsagePollScheduler {
  private readonly polls: Array<{ active: boolean; callback: () => void }> = [];

  schedulePoll(callback: () => void): () => void {
    const poll = { active: true, callback };
    this.polls.push(poll);
    return () => {
      poll.active = false;
    };
  }

  poll(): void {
    const poll = this.polls.shift();
    if (!poll) throw new Error("OMP has not scheduled a context usage poll");
    if (poll.active) poll.callback();
  }

  activePollCount(): number {
    return this.polls.filter((poll) => poll.active).length;
  }
}

function createToolCatalog(): PaseoToolCatalog {
  return {
    tools: new Map([
      [
        "create_agent",
        {
          name: "create_agent",
          description: "Create a Paseo agent.",
          handler: async () => ({ content: [] }),
        },
      ],
    ]),
    getTool: () => undefined,
    executeTool: async () => ({ content: [] }),
  };
}

describe("OMP agent client and session", () => {
  test("owns launch configuration and registers native host tools", async () => {
    const omp = new OmpHarness();
    await omp.start({ modeId: "ask" }, createToolCatalog());

    expect(omp.launchConfiguration()).toEqual({
      cwd: "/tmp/paseo-omp-agent-test",
      protocolMode: "rpc-ui",
      modeId: "ask",
      argv: ["omp", "--mode", "rpc-ui", "--approval-mode", "always-ask"],
    });
    expect(omp.registeredHostTools()).toEqual([
      [expect.objectContaining({ name: "create_agent" })],
    ]);
    expect(omp.capabilities()).toMatchObject({
      supportsMcpServers: false,
      supportsNativePaseoTools: true,
    });
  });

  test("preserves max as the selected thinking option", async () => {
    const omp = new OmpHarness();
    await omp.start({ thinkingOptionId: "max" });

    expect(omp.launchConfiguration().argv).toEqual(expect.arrayContaining(["--thinking", "max"]));
  });

  test("launches with write approval mode", async () => {
    const omp = new OmpHarness();
    await omp.start({ modeId: "write" });

    expect(omp.launchConfiguration()).toEqual({
      cwd: "/tmp/paseo-omp-agent-test",
      protocolMode: "rpc-ui",
      modeId: "write",
      argv: ["omp", "--mode", "rpc-ui", "--approval-mode", "write"],
    });
  });

  test("passes --thinking when a thinking option is provided", async () => {
    const omp = new OmpHarness();
    await omp.start({ modeId: "ask", thinkingOptionId: "xhigh" }, createToolCatalog());

    expect(omp.launchConfiguration().argv).toEqual([
      "omp",
      "--mode",
      "rpc-ui",
      "--approval-mode",
      "always-ask",
      "--thinking",
      "xhigh",
    ]);
  });

  test("streams a prompt through completion", async () => {
    const omp = new OmpHarness();
    await omp.start();

    await expect(omp.runPrompt("hello OMP", "hello from OMP")).resolves.toMatchObject({
      finalText: "hello from OMP",
    });
    expect(omp.timeline()).toEqual([
      { type: "user_message", text: "hello OMP", messageId: "user-1" },
      { type: "assistant_message", text: "hello from OMP", messageId: "omp-assistant-1" },
    ]);
    expect(omp.eventTypes().slice(0, 2)).toEqual(["turn_started", "timeline"]);
    expect(omp.completedTurnCount()).toBe(1);
  });

  test("streams OMP advisor messages as distinct tool-call blocks", async () => {
    const omp = new OmpHarness();
    await omp.start();

    await omp.runPromptWithCustomMessage(
      "review this",
      {
        role: "custom",
        content: '<advisory severity="concern">Exercise the failure path.</advisory>',
        customType: "advisor",
        id: "advisor-live-1",
        display: true,
        details: {
          notes: [{ note: "Exercise the failure path.", severity: "concern" }],
        },
      },
      "fixed",
    );

    expect(omp.timeline()).toEqual([
      { type: "user_message", text: "review this", messageId: "user-1" },
      {
        type: "tool_call",
        callId: "omp-advisor:advisor-live-1",
        name: "advisor",
        status: "completed",
        detail: {
          type: "plain_text",
          label: "Advisor · 1 note",
          text: "[concern] Exercise the failure path.",
          icon: "brain",
        },
        metadata: {
          synthetic: true,
          source: "omp_advisor",
          noteCount: 1,
          blockerCount: 0,
        },
        error: null,
      },
      { type: "assistant_message", text: "fixed", messageId: "omp-assistant-1" },
    ]);
  });

  test("completes a streamed assistant turn when agent_end omits messages", async () => {
    const omp = new OmpHarness();
    await omp.start();

    const { completion } = await omp.startPromptWithEmptyAgentEnd(
      "hello OMP",
      "empty terminal payload recovered",
    );
    await expect(completion).resolves.toMatchObject({
      finalText: "empty terminal payload recovered",
    });
    expect(omp.completedTurnCount()).toBe(1);
  });

  test("starts and stops context usage polling with the active turn", async () => {
    const scheduler = new ManualUsagePollScheduler();
    const omp = new OmpHarness({ usagePollScheduler: scheduler });
    await omp.start();
    omp.runtime().stats = {
      contextUsage: { tokens: 130, contextWindow: 200_000 },
    };
    omp.runtime().state.contextUsage = { tokens: 99, contextWindow: 100_000 };
    await omp.requireStartTurn("keep working");
    expect(scheduler.activePollCount()).toBe(1);
    scheduler.poll();
    await waitForImmediate();
    expect(omp.usageUpdates()).toEqual([
      {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        totalCostUsd: 0,
        contextWindowMaxTokens: 200_000,
        contextWindowUsedTokens: 130,
      },
    ]);
    expect(scheduler.activePollCount()).toBe(1);
    omp.runtime().abortError = new Error("abort unavailable");
    await expect(omp.interrupt()).rejects.toThrow("abort unavailable");
    expect(scheduler.activePollCount()).toBe(1);
    omp.runtime().abortError = null;
    await omp.interrupt();
    expect(scheduler.activePollCount()).toBe(0);

    await omp.runPrompt("finish normally", "done");
    expect(scheduler.activePollCount()).toBe(0);

    await omp.requireStartTurn("close the session");
    expect(scheduler.activePollCount()).toBe(1);
    await omp.close();
    expect(scheduler.activePollCount()).toBe(0);
  });

  test("does not accept a follow-up until OMP reports stable idle", async () => {
    const omp = new OmpHarness();
    await omp.start();

    await omp.runPrompt("first", "first done", [
      { isStreaming: true, isCompacting: false },
      { isStreaming: false, isCompacting: false },
      { isStreaming: false, isCompacting: false },
    ]);
    await expect(omp.runPrompt("follow-up", "follow-up done")).resolves.toMatchObject({
      finalText: "follow-up done",
    });
  });

  test("stays active while OMP remains busy", async () => {
    const scheduler = new ManualIdleScheduler();
    const omp = new OmpHarness({ providerIdleScheduler: scheduler });
    await omp.start();

    const { completion } = await omp.startPromptUntilProviderIdle("first", "first done", {
      isStreaming: true,
      isCompacting: false,
    });
    await omp.waitForProviderStateChecks(2);
    await scheduler.waitForWaits(1);

    expect(omp.completedTurnCount()).toBe(0);
    scheduler.retry();
    await omp.waitForProviderStateChecks(3);
    await scheduler.waitForWaits(2);
    expect(omp.completedTurnCount()).toBe(0);

    omp.reportProviderState({ isStreaming: false, isCompacting: false });
    scheduler.retry();
    await expect(completion).resolves.toMatchObject({ finalText: "first done" });
  });

  test("stays active when OMP state checks fail", async () => {
    const scheduler = new ManualIdleScheduler();
    const omp = new OmpHarness({ providerIdleScheduler: scheduler });
    await omp.start();
    omp.failProviderStateChecks(new Error("state unavailable"));

    const { completion } = await omp.startPromptUntilProviderIdle("first", "first done", {
      isStreaming: true,
      isCompacting: false,
    });
    await omp.waitForProviderStateChecks(2);
    await scheduler.waitForWaits(1);
    expect(omp.completedTurnCount()).toBe(0);

    omp.failProviderStateChecks(null);
    omp.reportProviderState({ isStreaming: false, isCompacting: false });
    scheduler.retry();
    await expect(completion).resolves.toMatchObject({ finalText: "first done" });
  });

  test("completes once when OMP repeats agent_end for the same turn", async () => {
    const scheduler = new ManualIdleScheduler();
    const omp = new OmpHarness({ providerIdleScheduler: scheduler });
    await omp.start();

    const { completion } = await omp.startPromptUntilProviderIdle("first", "first done", {
      isStreaming: true,
      isCompacting: false,
    });
    await omp.waitForProviderStateChecks(2);
    await scheduler.waitForWaits(1);

    // OMP can end a second cycle for the same prompt; the terminal assistant
    // message it already streamed would otherwise open a second gate.
    omp.runtime().finishTurn();
    for (let flush = 0; flush < 5; flush += 1) await waitForImmediate();
    expect(scheduler.attempts()).toHaveLength(1);

    omp.reportProviderState({ isStreaming: false, isCompacting: false });
    scheduler.retryAll();
    await expect(completion).resolves.toMatchObject({ finalText: "first done" });
    await waitForImmediate();
    expect(omp.completedTurnCount()).toBe(1);
  });

  test("fails the turn when OMP never reports idle", async () => {
    const scheduler = new ManualIdleScheduler((attempt) =>
      attempt.attempt < 2 ? { retry: true } : { retry: false, reason: "wait_budget" },
    );
    const omp = new OmpHarness({ providerIdleScheduler: scheduler });
    await omp.start();

    const { completion } = await omp.startPromptUntilProviderIdle("first", "first done", {
      isStreaming: true,
      isCompacting: false,
    });
    await scheduler.waitForWaits(1);
    scheduler.retryAll();

    await expect(completion).rejects.toThrow(/idle/i);
    expect(omp.completedTurnCount()).toBe(0);
    expect(omp.failedTurns()).toMatchObject([
      {
        code: "omp_provider_idle_timeout",
        diagnostic: expect.stringContaining("isStreaming=true"),
      },
    ]);
  });

  test("fails the turn when OMP state checks keep failing", async () => {
    const scheduler = new ManualIdleScheduler((attempt) =>
      attempt.consecutiveFailures < 2
        ? { retry: true }
        : { retry: false, reason: "failure_budget" },
    );
    const omp = new OmpHarness({ providerIdleScheduler: scheduler });
    await omp.start();
    omp.failProviderStateChecks(new Error("state unavailable"));

    const { completion } = await omp.startPromptUntilProviderIdle("first", "first done", {
      isStreaming: true,
      isCompacting: false,
    });
    await scheduler.waitForWaits(1);
    scheduler.retryAll();

    await expect(completion).rejects.toThrow(/state/i);
    expect(omp.completedTurnCount()).toBe(0);
    expect(omp.failedTurns()).toMatchObject([
      {
        code: "omp_provider_state_unavailable",
        diagnostic: expect.stringContaining("state unavailable"),
      },
    ]);
  });

  test("accepts a new prompt after a stalled turn fails", async () => {
    const scheduler = new ManualIdleScheduler((attempt) =>
      attempt.attempt < 2 ? { retry: true } : { retry: false, reason: "wait_budget" },
    );
    const omp = new OmpHarness({ providerIdleScheduler: scheduler });
    await omp.start();

    const { completion } = await omp.startPromptUntilProviderIdle("first", "first done", {
      isStreaming: true,
      isCompacting: false,
    });
    await scheduler.waitForWaits(1);
    scheduler.retryAll();
    await expect(completion).rejects.toThrow(/idle/i);

    omp.reportProviderState({ isStreaming: false, isCompacting: false });
    await expect(omp.runPrompt("second", "second done")).resolves.toMatchObject({
      finalText: "second done",
    });
  });

  test("completes an autonomous turn once when OMP repeats agent_end", async () => {
    const scheduler = new ManualIdleScheduler();
    const omp = new OmpHarness({ providerIdleScheduler: scheduler });
    await omp.start();

    omp.startAutonomousTurnUntilProviderIdle("autonomous done", {
      isStreaming: true,
      isCompacting: false,
    });
    await scheduler.waitForWaits(1);

    omp.runtime().finishTurn();
    for (let flush = 0; flush < 5; flush += 1) await waitForImmediate();
    expect(scheduler.attempts()).toHaveLength(1);

    omp.reportProviderState({ isStreaming: false, isCompacting: false });
    scheduler.retryAll();
    for (let flush = 0; flush < 5; flush += 1) await waitForImmediate();
    expect(omp.completedTurnCount()).toBe(1);
  });

  test("reports the last OMP state when the idle wait budget expires after a failed check", async () => {
    const scheduler = new ManualIdleScheduler((attempt) =>
      attempt.attempt < 3 ? { retry: true } : { retry: false, reason: "wait_budget" },
    );
    const omp = new OmpHarness({ providerIdleScheduler: scheduler });
    await omp.start();

    const { completion } = await omp.startPromptUntilProviderIdle("first", "first done", {
      isStreaming: true,
      isCompacting: false,
    });
    await scheduler.waitForWaits(1);
    omp.failProviderStateChecks(new Error("state unavailable"));
    scheduler.retryAll();
    await scheduler.waitForWaits(2);
    scheduler.retryAll();

    await expect(completion).rejects.toThrow(/idle/i);
    expect(omp.failedTurns()).toMatchObject([
      {
        code: "omp_provider_idle_timeout",
        diagnostic: expect.stringContaining("isStreaming=true"),
      },
    ]);
    // The failing check is still evidence; it must not be dropped.
    expect(omp.failedTurns()[0]?.diagnostic).toContain("state unavailable");
  });

  test("fails the turn with the newest agent_end error", async () => {
    const scheduler = new ManualIdleScheduler();
    const omp = new OmpHarness({ providerIdleScheduler: scheduler });
    await omp.start();

    const { completion } = await omp.startPromptUntilProviderIdle("first", "first done", {
      isStreaming: true,
      isCompacting: false,
    });
    await scheduler.waitForWaits(1);

    omp.runtime().finishTurn({ role: "assistant", content: [], errorMessage: "provider exploded" });
    for (let flush = 0; flush < 5; flush += 1) await waitForImmediate();

    omp.reportProviderState({ isStreaming: false, isCompacting: false });
    scheduler.retryAll();

    await expect(completion).rejects.toThrow(/provider exploded/);
    expect(omp.completedTurnCount()).toBe(0);
  });

  test("the default idle scheduler stops on its wait and failure budgets", async () => {
    const scheduler = createOmpProviderIdleScheduler();

    await expect(
      scheduler.waitForRetry({
        attempt: 1,
        consecutiveFailures: 0,
        elapsedMs: 0,
        totalElapsedMs: 0,
        isCompacting: false,
        isWaitingOnSubagents: false,
      }),
    ).resolves.toEqual({ retry: true });
    await expect(
      scheduler.waitForRetry({
        attempt: 200,
        consecutiveFailures: 0,
        elapsedMs: 60_000,
        totalElapsedMs: 60_000,
        isCompacting: false,
        isWaitingOnSubagents: false,
      }),
    ).resolves.toEqual({ retry: false, reason: "wait_budget" });
    await expect(
      scheduler.waitForRetry({
        attempt: 3,
        consecutiveFailures: 3,
        elapsedMs: 100,
        totalElapsedMs: 100,
        isCompacting: false,
        isWaitingOnSubagents: false,
      }),
    ).resolves.toEqual({ retry: false, reason: "failure_budget" });
  });

  test("cancels in-flight tool calls when a turn stalls", async () => {
    const scheduler = new ManualIdleScheduler((attempt) =>
      attempt.attempt < 2 ? { retry: true } : { retry: false, reason: "wait_budget" },
    );
    const omp = new OmpHarness({ providerIdleScheduler: scheduler });
    await omp.start();

    const { completion } = await omp.startPromptUntilProviderIdle("first", "first done", {
      isStreaming: true,
      isCompacting: false,
    });
    omp.runtime().emit({
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "bash",
      args: { command: "sleep 30" },
    });
    expect(omp.runningToolCallIds()).toEqual(["tool-1"]);

    await scheduler.waitForWaits(1);
    scheduler.retryAll();
    await expect(completion).rejects.toThrow(/idle/i);

    expect(omp.runningToolCallIds()).toEqual([]);
  });

  test("does not fail a turn that started after the gate was abandoned", async () => {
    // The deny lands after ownership has moved on: get_state and waitForRetry are
    // both awaits, so the turn can change under a parked gate.
    let releaseDeny!: () => void;
    let gateParked!: () => void;
    const parked = new Promise<void>((resolve) => {
      gateParked = resolve;
    });
    const scheduler: OmpProviderIdleScheduler = {
      waitForRetry: () => {
        gateParked();
        return new Promise((resolve) => {
          releaseDeny = () => resolve({ retry: false, reason: "wait_budget" });
        });
      },
    };
    const omp = new OmpHarness({ providerIdleScheduler: scheduler });
    await omp.start();

    const { completion } = await omp.startPromptUntilProviderIdle("first", "first done", {
      isStreaming: true,
      isCompacting: false,
    });
    await parked;

    // The user gives up on the stuck turn and sends another one.
    await omp.interrupt();
    await completion;
    omp.reportProviderState({ isStreaming: false, isCompacting: false });
    await omp.requireStartTurn("second");

    releaseDeny();
    for (let flush = 0; flush < 5; flush += 1) await waitForImmediate();

    expect(omp.failedTurns()).toEqual([]);
    const runtime = omp.runtime();
    runtime.beginTurn();
    runtime.streamAssistantText("second done");
    runtime.finishTurn();
    for (let flush = 0; flush < 5; flush += 1) await waitForImmediate();
    expect(omp.completedTurnCount()).toBe(1);
  });

  test("keeps polling past the idle budget while OMP reports compacting", async () => {
    const scheduler = createOmpProviderIdleScheduler();

    await expect(
      scheduler.waitForRetry({
        attempt: 1,
        consecutiveFailures: 0,
        elapsedMs: 120_000,
        totalElapsedMs: 120_000,
        isCompacting: true,
        isWaitingOnSubagents: false,
      }),
    ).resolves.toEqual({ retry: true });
    await expect(
      scheduler.waitForRetry({
        attempt: 1,
        consecutiveFailures: 0,
        elapsedMs: 120_000,
        totalElapsedMs: 120_000,
        isCompacting: false,
        isWaitingOnSubagents: false,
      }),
    ).resolves.toEqual({ retry: false, reason: "wait_budget" });
  });

  test("reports the observed compaction state and elapsed time to the scheduler", async () => {
    const scheduler = new ManualIdleScheduler();
    const omp = new OmpHarness({ providerIdleScheduler: scheduler });
    await omp.start();

    await omp.startPromptUntilProviderIdle("first", "first done", {
      isStreaming: false,
      isCompacting: true,
    });
    await scheduler.waitForWaits(1);
    expect(scheduler.attempts()[0]?.isCompacting).toBe(true);

    await delay(5);
    scheduler.retryAll();
    await scheduler.waitForWaits(2);
    expect(scheduler.attempts()[1]?.elapsedMs).toBeGreaterThanOrEqual(5);
  });

  test("keeps an earlier agent_end error when a later cycle reports none", async () => {
    const scheduler = new ManualIdleScheduler();
    const omp = new OmpHarness({ providerIdleScheduler: scheduler });
    await omp.start();

    const { completion } = await omp.startPromptUntilProviderIdle("first", "first done", {
      isStreaming: true,
      isCompacting: false,
    });
    await scheduler.waitForWaits(1);

    omp.runtime().finishTurn({ role: "assistant", content: [], errorMessage: "provider exploded" });
    omp.runtime().finishTurn();
    for (let flush = 0; flush < 5; flush += 1) await waitForImmediate();

    omp.reportProviderState({ isStreaming: false, isCompacting: false });
    scheduler.retryAll();

    await expect(completion).rejects.toThrow(/provider exploded/);
  });

  test("reports an unavailable state path when no OMP state was ever observed", async () => {
    const scheduler = new ManualIdleScheduler((attempt) =>
      attempt.attempt < 2 ? { retry: true } : { retry: false, reason: "wait_budget" },
    );
    const omp = new OmpHarness({ providerIdleScheduler: scheduler });
    await omp.start();
    omp.failProviderStateChecks(new Error("state unavailable"));

    const { completion } = await omp.startPromptUntilProviderIdle("first", "first done", {
      isStreaming: true,
      isCompacting: false,
    });
    await scheduler.waitForWaits(1);
    scheduler.retryAll();

    await expect(completion).rejects.toThrow(/state/i);
    expect(omp.failedTurns()).toMatchObject([{ code: "omp_provider_state_unavailable" }]);
    expect(omp.failedTurns()[0]?.diagnostic).toContain("2 consecutive failures");
  });

  // #2232: parent model loop can go idle while OMP-internal `task` children
  // keep writing. Wire order is tool_execution_end (dispatch ack) then
  // subagent_lifecycle started — never the reverse.
  test("stays active while OMP internal task subagents are still running", async () => {
    const scheduler = new ManualIdleScheduler();
    const omp = new OmpHarness({ providerIdleScheduler: scheduler });
    await omp.start();

    const session = omp;
    await session.requireStartTurn("critically audit the entire repo");
    const runtime = session.runtime();
    runtime.beginTurn();
    runtime.acceptPrompt("critically audit the entire repo", "user-audit");
    runtime.streamAssistantText("spawning fan-out workers");
    runtime.emit({
      type: "tool_execution_start",
      toolCallId: "task-1",
      toolName: "task",
      args: { description: "audit API budget" },
    });
    runtime.emit({
      type: "tool_execution_end",
      toolCallId: "task-1",
      toolName: "task",
      isError: false,
      result: { text: "Spawned 1 background agent" },
    });
    runtime.emit({
      type: "subagent_lifecycle",
      payload: {
        id: "ApiBudgetAudit",
        agent: "ApiBudgetAudit",
        description: "audit API budget",
        status: "started",
        parentToolCallId: "task-1",
        index: 0,
      },
    });
    runtime.state = { ...runtime.state, isStreaming: false, isCompacting: false };
    runtime.finishTurn({
      role: "assistant",
      content: [{ type: "text", text: "spawning fan-out workers" }],
    });

    await session.waitForProviderStateChecks(1);
    await scheduler.waitForWaits(1);
    expect(session.completedTurnCount()).toBe(0);
    expect(session.subagentUpserts()).toContainEqual({ id: "ApiBudgetAudit", status: "running" });

    scheduler.retry();
    await session.waitForProviderStateChecks(2);
    await scheduler.waitForWaits(2);
    expect(session.completedTurnCount()).toBe(0);

    runtime.emit({
      type: "subagent_lifecycle",
      payload: {
        id: "ApiBudgetAudit",
        agent: "ApiBudgetAudit",
        status: "completed",
        parentToolCallId: "task-1",
        index: 0,
      },
    });
    scheduler.retry();
    await session.waitForProviderStateChecks(3);
    await waitForImmediate();
    expect(session.completedTurnCount()).toBe(1);
    expect(session.subagentUpserts()).toContainEqual({
      id: "ApiBudgetAudit",
      status: "completed",
    });
  });

  test("stays active when get_subagents reports running children without prior events", async () => {
    const scheduler = new ManualIdleScheduler();
    const omp = new OmpHarness({ providerIdleScheduler: scheduler });
    await omp.start();

    await omp.requireStartTurn("fan out");
    const runtime = omp.runtime();
    runtime.beginTurn();
    runtime.acceptPrompt("fan out", "user-fanout");
    runtime.streamAssistantText("delegating");
    runtime.subagents = [
      {
        id: "PipelineFeedAudit",
        index: 0,
        agent: "PipelineFeedAudit",
        status: "running",
        parentToolCallId: "task-2",
      },
    ];
    runtime.state = { ...runtime.state, isStreaming: false, isCompacting: false };
    runtime.finishTurn({
      role: "assistant",
      content: [{ type: "text", text: "delegating" }],
    });

    await omp.waitForProviderStateChecks(1);
    await scheduler.waitForWaits(1);
    expect(omp.completedTurnCount()).toBe(0);

    runtime.subagents = [];
    scheduler.retry();
    await omp.waitForProviderStateChecks(2);
    await waitForImmediate();
    expect(omp.completedTurnCount()).toBe(1);
  });

  test("does not treat an empty get_subagents reply as completion for never-listed children", async () => {
    const scheduler = new ManualIdleScheduler();
    const omp = new OmpHarness({ providerIdleScheduler: scheduler });
    await omp.start();

    await omp.requireStartTurn("audit");
    const runtime = omp.runtime();
    runtime.beginTurn();
    runtime.acceptPrompt("audit", "user-audit");
    runtime.streamAssistantText("working");
    runtime.emit({
      type: "subagent_lifecycle",
      payload: {
        id: "OnlyLifecycle",
        agent: "OnlyLifecycle",
        status: "started",
        index: 0,
      },
    });
    runtime.subagents = [];
    runtime.state = { ...runtime.state, isStreaming: false, isCompacting: false };
    runtime.finishTurn({
      role: "assistant",
      content: [{ type: "text", text: "working" }],
    });

    await omp.waitForProviderStateChecks(1);
    await scheduler.waitForWaits(1);
    expect(omp.completedTurnCount()).toBe(0);

    runtime.emit({
      type: "subagent_lifecycle",
      payload: {
        id: "OnlyLifecycle",
        agent: "OnlyLifecycle",
        status: "completed",
        index: 0,
      },
    });
    scheduler.retry();
    await omp.waitForProviderStateChecks(2);
    await waitForImmediate();
    expect(omp.completedTurnCount()).toBe(1);
  });

  test("keeps the parent active when get_subagents is unavailable", async () => {
    const scheduler = new ManualIdleScheduler();
    const omp = new OmpHarness({ providerIdleScheduler: scheduler });
    await omp.start();

    await omp.requireStartTurn("legacy omp");
    const runtime = omp.runtime();
    runtime.getSubagentsError = new Error("unknown command get_subagents");
    runtime.beginTurn();
    runtime.acceptPrompt("legacy omp", "user-legacy");
    runtime.streamAssistantText("delegating");
    runtime.emit({
      type: "subagent_lifecycle",
      payload: {
        id: "LegacyChild",
        agent: "LegacyChild",
        status: "started",
        index: 0,
      },
    });
    runtime.state = { ...runtime.state, isStreaming: false, isCompacting: false };
    runtime.finishTurn({
      role: "assistant",
      content: [{ type: "text", text: "delegating" }],
    });

    await omp.waitForProviderStateChecks(1);
    await scheduler.waitForWaits(1);
    expect(omp.completedTurnCount()).toBe(0);

    runtime.emit({
      type: "subagent_lifecycle",
      payload: {
        id: "LegacyChild",
        agent: "LegacyChild",
        status: "completed",
        index: 0,
      },
    });
    scheduler.retry();
    await omp.waitForProviderStateChecks(2);
    await waitForImmediate();
    expect(omp.completedTurnCount()).toBe(1);
  });

  test("holds a task tool call open when its OMP children appear after the result", async () => {
    const omp = new OmpHarness();
    await omp.start();

    await omp.requireStartTurn("fan out");
    const runtime = omp.runtime();
    runtime.beginTurn();
    runtime.acceptPrompt("fan out", "user-fanout");
    runtime.streamAssistantText("delegating");
    runtime.emit({
      type: "tool_execution_start",
      toolCallId: "task-1",
      toolName: "task",
      args: { description: "spawn workers" },
    });
    runtime.emit({
      type: "tool_execution_end",
      toolCallId: "task-1",
      toolName: "task",
      isError: false,
      result: { text: "Spawned 1 background agent" },
    });
    expect(lastToolCallStatus(omp, "task-1")).toBe("running");
    expect(omp.runningToolCallIds()).toEqual(["task-1"]);

    runtime.emit({
      type: "subagent_lifecycle",
      payload: {
        id: "Worker",
        agent: "Worker",
        status: "started",
        parentToolCallId: "task-1",
        index: 0,
      },
    });
    expect(lastToolCallStatus(omp, "task-1")).toBe("running");
    expect(omp.runningToolCallIds()).toEqual(["task-1"]);

    runtime.emit({
      type: "subagent_progress",
      payload: {
        index: 0,
        agent: "Worker",
        parentToolCallId: "task-1",
        progress: { id: "Worker", status: "running", recentOutput: ["still working"] },
      },
    });
    expect(lastToolCallStatus(omp, "task-1")).toBe("running");

    runtime.emit({
      type: "subagent_lifecycle",
      payload: {
        id: "Worker",
        agent: "Worker",
        status: "completed",
        parentToolCallId: "task-1",
        index: 0,
      },
    });
    expect(lastToolCallStatus(omp, "task-1")).toBe("completed");
    expect(omp.runningToolCallIds()).toEqual([]);
  });

  test("force-settles a task that never produced a child when the turn completes", async () => {
    const omp = new OmpHarness();
    await omp.start();

    const session = omp;
    await session.requireStartTurn("no child");
    const runtime = session.runtime();
    runtime.beginTurn();
    runtime.acceptPrompt("no child", "user-orphan");
    runtime.streamAssistantText("done");
    runtime.emit({
      type: "tool_execution_start",
      toolCallId: "task-orphan",
      toolName: "task",
      args: { description: "never spawned" },
    });
    runtime.emit({
      type: "tool_execution_end",
      toolCallId: "task-orphan",
      toolName: "task",
      isError: false,
      result: { text: "Spawned 0 background agents" },
    });
    expect(lastToolCallStatus(session, "task-orphan")).toBe("running");

    runtime.state = { ...runtime.state, isStreaming: false, isCompacting: false };
    runtime.finishTurn({
      role: "assistant",
      content: [{ type: "text", text: "done" }],
    });
    await waitForImmediate();
    await waitForImmediate();
    expect(session.completedTurnCount()).toBe(1);
    expect(lastToolCallStatus(session, "task-orphan")).toBe("completed");
    expect(session.runningToolCallIds()).toEqual([]);
  });

  test("completes a failed task immediately", async () => {
    const omp = new OmpHarness();
    await omp.start();

    await omp.requireStartTurn("task fails");
    const runtime = omp.runtime();
    runtime.beginTurn();
    runtime.emit({
      type: "tool_execution_start",
      toolCallId: "task-fail",
      toolName: "task",
      args: { description: "boom" },
    });
    runtime.emit({
      type: "tool_execution_end",
      toolCallId: "task-fail",
      toolName: "task",
      isError: true,
      result: { text: "spawn failed" },
    });
    expect(lastToolCallStatus(omp, "task-fail")).toBe("failed");
    expect(omp.runningToolCallIds()).toEqual([]);
  });

  test("waits past the idle budget while OMP reports running subagents", async () => {
    const scheduler = createOmpProviderIdleScheduler();

    await expect(
      scheduler.waitForRetry({
        attempt: 1,
        consecutiveFailures: 0,
        elapsedMs: 120_000,
        totalElapsedMs: 120_000,
        isCompacting: false,
        isWaitingOnSubagents: true,
      }),
    ).resolves.toEqual({ retry: true });
  });

  test("stops trusting a subagent wait once get_subagents stops answering", async () => {
    let clock = 0;
    const scheduler = new ManualIdleScheduler();
    const omp = new OmpHarness({ providerIdleScheduler: scheduler, now: () => clock });
    await omp.start();

    omp.reportSubagentSnapshots([{ id: "child-1", index: 0, agent: "worker", status: "running" }]);
    const { completion } = await omp.startPromptUntilProviderIdle("fan out", "dispatched", {
      isStreaming: false,
      isCompacting: false,
    });
    await scheduler.waitForWaits(1);

    // A snapshot that cannot be fetched is not evidence that work continues, so
    // the clock keeps running even though the gate still waits on the child.
    omp.failSubagentSnapshots(new Error("subagents unavailable"));
    clock += 120_000;
    scheduler.retryAll();
    await scheduler.waitForWaits(2);
    expect(scheduler.attempts()[1]?.isWaitingOnSubagents).toBe(true);
    expect(scheduler.attempts()[1]?.elapsedMs).toBeGreaterThanOrEqual(120_000);
    void completion;
  });

  test("does not let an unconfirmed subagent hold the clock open", async () => {
    let clock = 0;
    const scheduler = new ManualIdleScheduler();
    const omp = new OmpHarness({ providerIdleScheduler: scheduler, now: () => clock });
    await omp.start();

    await omp.requireStartTurn("fan out");
    const runtime = omp.runtime();
    runtime.beginTurn();
    runtime.acceptPrompt("fan out", "user-fan");
    runtime.streamAssistantText("dispatching");
    // A lifecycle child that no get_subagents reply ever lists: the gate still
    // waits on it, but OMP has never confirmed it is doing anything.
    runtime.emit({
      type: "subagent_lifecycle",
      payload: { id: "child-1", agent: "worker", status: "started", index: 0 },
    });
    runtime.state = { ...runtime.state, isStreaming: false, isCompacting: false };
    runtime.finishTurn();

    await scheduler.waitForWaits(1);
    expect(scheduler.attempts()[0]?.isWaitingOnSubagents).toBe(true);
    clock += 90_000;
    scheduler.retryAll();
    await scheduler.waitForWaits(2);
    expect(scheduler.attempts()[1]?.elapsedMs).toBeGreaterThanOrEqual(90_000);
  });

  test("does not credit progress when get_state fails", async () => {
    let clock = 0;
    const scheduler = new ManualIdleScheduler();
    const omp = new OmpHarness({ providerIdleScheduler: scheduler, now: () => clock });
    await omp.start();

    omp.reportSubagentSnapshots([{ id: "child-1", index: 0, agent: "worker", status: "running" }]);
    const { completion } = await omp.startPromptUntilProviderIdle("fan out", "dispatched", {
      isStreaming: false,
      isCompacting: false,
    });
    await scheduler.waitForWaits(1);

    // With get_state down there is no fresh subagent reply either, so the last
    // confirmation must not keep restarting the clock.
    omp.failProviderStateChecks(new Error("state unavailable"));
    clock += 120_000;
    scheduler.retryAll();
    await scheduler.waitForWaits(2);
    expect(scheduler.attempts()[1]?.elapsedMs).toBeGreaterThanOrEqual(120_000);
    void completion;
  });

  test("names unconfirmed subagents when the gate gives up waiting on them", async () => {
    const scheduler = new ManualIdleScheduler((attempt) =>
      attempt.attempt < 2 ? { retry: true } : { retry: false, reason: "wait_budget" },
    );
    const omp = new OmpHarness({ providerIdleScheduler: scheduler });
    await omp.start();

    omp.reportSubagentSnapshots([{ id: "child-1", index: 0, agent: "worker", status: "running" }]);
    const { completion } = await omp.startPromptUntilProviderIdle("fan out", "dispatched", {
      isStreaming: false,
      isCompacting: false,
    });
    await scheduler.waitForWaits(1);

    // The snapshot path goes down while the index still holds a running child.
    omp.failSubagentSnapshots(new Error("subagents unavailable"));
    scheduler.retryAll();

    await expect(completion).rejects.toThrow(/subagent/i);
    expect(omp.failedTurns()[0]?.diagnostic).toContain("running subagents");
  });

  test("does not claim consecutive failures when the last state check succeeded", async () => {
    const scheduler = new ManualIdleScheduler((attempt) =>
      attempt.attempt < 3 ? { retry: true } : { retry: false, reason: "wait_budget" },
    );
    const omp = new OmpHarness({ providerIdleScheduler: scheduler });
    await omp.start();
    omp.failProviderStateChecks(new Error("state unavailable"));

    const { completion } = await omp.startPromptUntilProviderIdle("first", "first done", {
      isStreaming: true,
      isCompacting: false,
    });
    await scheduler.waitForWaits(1);
    omp.failProviderStateChecks(null);
    scheduler.retryAll();
    await scheduler.waitForWaits(2);
    scheduler.retryAll();

    await expect(completion).rejects.toThrow();
    const diagnostic = omp.failedTurns()[0]?.diagnostic ?? "";
    expect(diagnostic).toContain("state unavailable");
    expect(diagnostic).not.toContain("consecutive failures");
  });

  test("does not spend the idle budget while OMP is still emitting events", async () => {
    let clock = 0;
    const scheduler = new ManualIdleScheduler();
    const omp = new OmpHarness({ providerIdleScheduler: scheduler, now: () => clock });
    await omp.start();

    const { completion } = await omp.startPromptUntilProviderIdle("first", "first done", {
      isStreaming: true,
      isCompacting: false,
    });
    await scheduler.waitForWaits(1);

    // OMP streams a second cycle for the same prompt: slow, but demonstrably
    // alive. Silence is the stall this budget is for, not elapsed time.
    clock += 90_000;
    omp.runtime().streamAssistantText("still working");
    scheduler.retryAll();
    await scheduler.waitForWaits(2);
    expect(scheduler.attempts()[1]?.elapsedMs).toBeLessThan(60_000);

    // Now it goes quiet.
    clock += 90_000;
    scheduler.retryAll();
    await scheduler.waitForWaits(3);
    expect(scheduler.attempts()[2]?.elapsedMs).toBeGreaterThanOrEqual(90_000);
    void completion;
  });

  test("keeps spending the budget while the reported state oscillates", async () => {
    let clock = 0;
    const scheduler = new ManualIdleScheduler();
    const omp = new OmpHarness({ providerIdleScheduler: scheduler, now: () => clock });
    await omp.start();

    const { completion } = await omp.startPromptUntilProviderIdle("first", "first done", {
      isStreaming: true,
      isCompacting: false,
    });
    await scheduler.waitForWaits(1);

    // A flag flipping back and forth is not progress, so each budget keeps its
    // own accrued silence instead of being reset by the change.
    for (let round = 0; round < 4; round += 1) {
      clock += 60_000;
      omp.reportProviderState({
        isStreaming: round % 2 === 0,
        isCompacting: round % 2 === 1,
      });
      scheduler.retryAll();
      await scheduler.waitForWaits(round + 2);
    }
    const stallSilence = scheduler
      .attempts()
      .filter((attempt) => !attempt.isCompacting)
      .map((attempt) => attempt.elapsedMs);
    expect(stallSilence.at(-1)).toBeGreaterThanOrEqual(120_000);
    void completion;
  });

  test("reports the live subagent state when the gate gives up", async () => {
    const scheduler = new ManualIdleScheduler((attempt) =>
      attempt.attempt < 3 ? { retry: true } : { retry: false, reason: "wait_budget" },
    );
    const omp = new OmpHarness({ providerIdleScheduler: scheduler, now: () => 0 });
    await omp.start();

    omp.reportSubagentSnapshots([{ id: "child-1", index: 0, agent: "worker", status: "running" }]);
    const { completion } = await omp.startPromptUntilProviderIdle("fan out", "dispatched", {
      isStreaming: false,
      isCompacting: false,
    });
    await scheduler.waitForWaits(1);

    // The child reports done, then the parent stalls with nothing running.
    omp.runtime().emit({
      type: "subagent_lifecycle",
      payload: { id: "child-1", agent: "worker", status: "completed", index: 0 },
    });
    omp.reportProviderState({ isStreaming: true, isCompacting: false });
    scheduler.retryAll();
    await scheduler.waitForWaits(2);
    scheduler.retryAll();

    await expect(completion).rejects.toThrow(/idle state/);
    expect(omp.failedTurns()).toMatchObject([{ code: "omp_provider_idle_timeout" }]);
    expect(omp.failedTurns()[0]?.diagnostic).not.toContain("subagents");
  });

  test("does not complete a turn the gate no longer owns", async () => {
    const scheduler = new ManualIdleScheduler();
    const omp = new OmpHarness({ providerIdleScheduler: scheduler });
    await omp.start();

    const { completion } = await omp.startPromptUntilProviderIdle("first", "first done", {
      isStreaming: true,
      isCompacting: false,
    });
    await scheduler.waitForWaits(1);

    // Park the gate inside get_state, which carries the RPC timeout, and let the
    // turn change while it is in there.
    omp.reportProviderState({ isStreaming: false, isCompacting: false });
    omp.runtime().holdStateChecks = true;
    scheduler.retryAll();
    await omp.waitForProviderStateChecks(2);
    await omp.interrupt();
    await completion;
    const completedAfterCancel = omp.completedTurnCount();

    omp.runtime().releaseStateChecks();
    for (let flush = 0; flush < 5; flush += 1) await waitForImmediate();
    expect(omp.completedTurnCount()).toBe(completedAfterCancel);
  });

  test("does not charge compaction silence to the stall budget when compaction ends", async () => {
    let clock = 0;
    const scheduler = new ManualIdleScheduler();
    const omp = new OmpHarness({ providerIdleScheduler: scheduler, now: () => clock });
    await omp.start();

    const { completion } = await omp.startPromptUntilProviderIdle("first", "first done", {
      isStreaming: false,
      isCompacting: true,
    });
    await scheduler.waitForWaits(1);

    // Three silent minutes of auto-compaction, well inside its own budget.
    clock += 180_000;
    scheduler.retryAll();
    await scheduler.waitForWaits(2);
    expect(scheduler.attempts()[1]?.isCompacting).toBe(true);

    // Compaction ends and the model resumes before emitting its first token.
    omp.reportProviderState({ isStreaming: true, isCompacting: false });
    scheduler.retryAll();
    await scheduler.waitForWaits(3);
    expect(scheduler.attempts()[2]?.isCompacting).toBe(false);
    expect(scheduler.attempts()[2]?.elapsedMs).toBeLessThan(60_000);
    expect(omp.failedTurns()).toEqual([]);
    void completion;
  });

  test("does not treat an unchanging subagent snapshot as progress", async () => {
    let clock = 0;
    const scheduler = new ManualIdleScheduler();
    const omp = new OmpHarness({ providerIdleScheduler: scheduler, now: () => clock });
    await omp.start();

    omp.reportSubagentSnapshots([
      { id: "child-1", index: 0, agent: "worker", status: "running", lastUpdate: 1 },
    ]);
    const { completion } = await omp.startPromptUntilProviderIdle("fan out", "dispatched", {
      isStreaming: false,
      isCompacting: false,
    });
    await scheduler.waitForWaits(1);

    // The same reply, over and over, is a stuck child rather than a working one.
    for (let round = 0; round < 3; round += 1) {
      clock += 120_000;
      scheduler.retryAll();
      await scheduler.waitForWaits(round + 2);
    }
    expect(scheduler.attempts()[3]?.isWaitingOnSubagents).toBe(true);
    expect(scheduler.attempts()[3]?.elapsedMs).toBeGreaterThanOrEqual(240_000);
    void completion;
  });

  test("counts a moving subagent snapshot as progress", async () => {
    let clock = 0;
    const scheduler = new ManualIdleScheduler();
    const omp = new OmpHarness({ providerIdleScheduler: scheduler, now: () => clock });
    await omp.start();

    omp.reportSubagentSnapshots([
      { id: "child-1", index: 0, agent: "worker", status: "running", lastUpdate: 1 },
    ]);
    const { completion } = await omp.startPromptUntilProviderIdle("fan out", "dispatched", {
      isStreaming: false,
      isCompacting: false,
    });
    await scheduler.waitForWaits(1);

    clock += 120_000;
    omp.reportSubagentSnapshots([
      { id: "child-1", index: 0, agent: "worker", status: "running", lastUpdate: 2 },
    ]);
    scheduler.retryAll();
    await scheduler.waitForWaits(2);
    clock += 1_000;
    scheduler.retryAll();
    await scheduler.waitForWaits(3);
    expect(scheduler.attempts()[2]?.elapsedMs).toBeLessThan(120_000);
    void completion;
  });

  test("counts a subagent progress frame as progress", async () => {
    let clock = 0;
    const scheduler = new ManualIdleScheduler();
    const omp = new OmpHarness({ providerIdleScheduler: scheduler, now: () => clock });
    await omp.start();

    await omp.requireStartTurn("fan out");
    const runtime = omp.runtime();
    runtime.beginTurn();
    runtime.acceptPrompt("fan out", "user-fan");
    runtime.streamAssistantText("dispatching");
    runtime.emit({
      type: "subagent_lifecycle",
      payload: { id: "child-1", agent: "worker", status: "started", index: 0 },
    });
    runtime.state = { ...runtime.state, isStreaming: false, isCompacting: false };
    runtime.finishTurn();
    // Legacy OMP: no snapshot path, only narration.
    omp.failSubagentSnapshots(new Error("unknown command get_subagents"));
    await scheduler.waitForWaits(1);

    clock += 120_000;
    runtime.emit({
      type: "subagent_progress",
      payload: {
        id: "child-1",
        agent: "worker",
        index: 0,
        progress: { id: "child-1", status: "running" },
      },
    });
    scheduler.retryAll();
    await scheduler.waitForWaits(2);
    expect(scheduler.attempts()[1]?.elapsedMs).toBeLessThan(120_000);
  });

  test("stops reporting a subagent wait once the child reports done", async () => {
    const scheduler = new ManualIdleScheduler();
    const omp = new OmpHarness({ providerIdleScheduler: scheduler });
    await omp.start();

    omp.reportSubagentSnapshots([{ id: "child-1", index: 0, agent: "worker", status: "running" }]);
    const { completion } = await omp.startPromptUntilProviderIdle("fan out", "dispatched", {
      isStreaming: false,
      isCompacting: false,
    });
    await scheduler.waitForWaits(1);
    expect(scheduler.attempts()[0]?.isWaitingOnSubagents).toBe(true);

    omp.runtime().emit({
      type: "subagent_lifecycle",
      payload: { id: "child-1", agent: "worker", status: "completed", index: 0 },
    });
    // The model goes busy, so the gate cannot re-poll get_subagents.
    omp.reportProviderState({ isStreaming: true, isCompacting: false });
    scheduler.retryAll();
    await scheduler.waitForWaits(2);
    expect(scheduler.attempts()[1]?.isWaitingOnSubagents).toBe(false);
    void completion;
  });

  test("gives up on a stalled turn even while OMP keeps chattering", async () => {
    let clock = 0;
    const scheduler = new ManualIdleScheduler();
    const omp = new OmpHarness({ providerIdleScheduler: scheduler, now: () => clock });
    await omp.start();

    const { completion } = await omp.startPromptUntilProviderIdle("first", "first done", {
      isStreaming: true,
      isCompacting: false,
    });
    await scheduler.waitForWaits(1);

    // Host-level chatter is not the turn advancing, and even if it were, the
    // gate must not outlive its ceiling.
    for (let round = 0; round < 6; round += 1) {
      clock += 600_000;
      omp.runtime().emit({ type: "notice", level: "info", message: "mcp server reloaded" });
      scheduler.retryAll();
      await scheduler.waitForWaits(round + 2);
    }
    const last = scheduler.attempts().at(-1);
    expect(last?.elapsedMs).toBeGreaterThanOrEqual(600_000);
    expect(last?.totalElapsedMs).toBeGreaterThanOrEqual(3_600_000);
    void completion;
  });

  test("the default idle scheduler stops at the ceiling whatever the class", async () => {
    const scheduler = createOmpProviderIdleScheduler();

    await expect(
      scheduler.waitForRetry({
        attempt: 1,
        consecutiveFailures: 0,
        elapsedMs: 0,
        totalElapsedMs: 3_600_000,
        isCompacting: true,
        isWaitingOnSubagents: true,
      }),
    ).resolves.toEqual({ retry: false, reason: "wait_budget" });
  });

  test("counts a running tool call as outstanding work", async () => {
    const scheduler = new ManualIdleScheduler();
    const omp = new OmpHarness({ providerIdleScheduler: scheduler });
    await omp.start();

    await omp.requireStartTurn("run something slow");
    const runtime = omp.runtime();
    runtime.beginTurn();
    runtime.acceptPrompt("run something slow", "user-1");
    runtime.streamAssistantText("running");
    runtime.emit({
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "bash",
      args: { command: "sleep 600" },
    });
    runtime.state = { ...runtime.state, isStreaming: true, isCompacting: false };
    runtime.finishTurn();

    await scheduler.waitForWaits(1);
    expect(scheduler.attempts()[0]?.isWaitingOnSubagents).toBe(true);
  });

  test("does not count a tool call left over from an earlier turn", async () => {
    const scheduler = new ManualIdleScheduler();
    const omp = new OmpHarness({ providerIdleScheduler: scheduler });
    await omp.start();

    // Turn one leaks a tool call: OMP never sends its tool_execution_end.
    await omp.requireStartTurn("first");
    const runtime = omp.runtime();
    runtime.beginTurn();
    runtime.acceptPrompt("first", "user-1");
    runtime.emit({
      type: "tool_execution_start",
      toolCallId: "orphan-1",
      toolName: "bash",
      args: { command: "sleep 1" },
    });
    runtime.streamAssistantText("first done");
    runtime.state = { ...runtime.state, isStreaming: false, isCompacting: false };
    runtime.finishTurn();
    for (let flush = 0; flush < 5; flush += 1) await waitForImmediate();

    await omp.requireStartTurn("second");
    runtime.beginTurn();
    runtime.acceptPrompt("second", "user-2");
    runtime.streamAssistantText("second running");
    runtime.state = { ...runtime.state, isStreaming: true, isCompacting: false };
    runtime.finishTurn();

    await scheduler.waitForWaits(1);
    expect(scheduler.attempts()[0]?.isWaitingOnSubagents).toBe(false);
  });

  test("does not describe finished children as a subagent stall", async () => {
    const scheduler = new ManualIdleScheduler((attempt) =>
      attempt.attempt < 2 ? { retry: true } : { retry: false, reason: "wait_budget" },
    );
    const omp = new OmpHarness({ providerIdleScheduler: scheduler, now: () => 0 });
    await omp.start();

    // A reply listing only finished children names nothing still going.
    omp.reportSubagentSnapshots([
      { id: "child-1", index: 0, agent: "worker", status: "completed" },
    ]);
    await omp.requireStartTurn("fan out");
    const runtime = omp.runtime();
    runtime.beginTurn();
    runtime.acceptPrompt("fan out", "user-fan");
    runtime.streamAssistantText("dispatching");
    runtime.emit({
      type: "subagent_lifecycle",
      payload: { id: "child-2", agent: "worker", status: "started", index: 1 },
    });
    runtime.state = { ...runtime.state, isStreaming: false, isCompacting: false };
    runtime.finishTurn();

    await scheduler.waitForWaits(1);
    scheduler.retryAll();
    await waitForImmediate();

    expect(omp.failedTurns()[0]?.diagnostic).toContain("would not confirm");
  });

  test("does not complete on OMP's extension-notice agent_end", async () => {
    const omp = new OmpHarness();
    await omp.start();

    await expect(
      omp.runPromptAfterExtensionNotice("hello OMP", "model turn completed"),
    ).resolves.toMatchObject({ finalText: expect.stringContaining("model turn completed") });
    expect(omp.completedTurnCount()).toBe(1);
  });

  test("omits live custom messages when display is false", async () => {
    const omp = new OmpHarness();
    await omp.start();

    await expect(
      omp.runPromptAfterExtensionNotice("hello OMP", "model turn completed", false),
    ).resolves.toMatchObject({ finalText: expect.stringContaining("model turn completed") });
    expect(omp.timeline()).toEqual([
      { type: "user_message", text: "hello OMP", messageId: "user-1" },
      {
        type: "assistant_message",
        text: "model turn completed",
        messageId: "omp-assistant-1",
      },
    ]);
  });

  test("renders a live system-notice custom message as a synthetic tool call", async () => {
    const omp = new OmpHarness();
    await omp.start();

    await omp.runPrompt("hello OMP", "done");
    omp
      .runtime()
      .acceptCustomMessage(
        [
          "<system-notice>",
          "Background job DocsSmokeTwo has completed.",
          '<task-result id="DocsSmokeTwo" agent="explore" status="completed" duration="21.6s">',
          "<output>done</output>",
          "</task-result>",
          "</system-notice>",
        ].join("\n"),
      );
    omp.runtime().acceptCustomMessage("plain custom status text");

    expect(omp.timeline().filter((item) => item.type === "tool_call")).toMatchObject([
      { callId: "omp-notice:DocsSmokeTwo", name: "task_notification", status: "completed" },
    ]);
    // Non-notice custom messages still fall through as assistant messages.
    expect(omp.timeline().filter((item) => item.type === "assistant_message")).toMatchObject([
      { text: "done" },
      { text: "plain custom status text" },
    ]);
  });

  test("does not complete a queued model turn from OMP's local-only hint", async () => {
    const omp = new OmpHarness();
    await omp.start();

    await expect(
      omp.runPromptAfterFalseLocalOnlyHint("hello OMP", "queued model turn completed"),
    ).resolves.toMatchObject({ finalText: "queued model turn completed" });
    expect(omp.completedTurnCount()).toBe(1);
  });

  test("completes a local-only prompt when no OMP turn begins", async () => {
    const omp = new OmpHarness();
    await omp.start();

    await expect(omp.runPromptWithoutTurn("/model")).resolves.toMatchObject({ finalText: "" });
    expect(omp.completedTurnCount()).toBe(1);
  });

  test("waits for a delayed queued model turn after OMP's local-only result", async () => {
    const omp = new OmpHarness();
    await omp.start();

    const completion = await omp.runPromptAfterDelayedFalseLocalOnlyResult(
      "hello OMP",
      "delayed queued model turn completed",
    );

    expect(completion.completedBeforeTurn).toBe(false);
    expect(completion.result).toMatchObject({ finalText: "delayed queued model turn completed" });
    expect(omp.completedTurnCount()).toBe(1);
  });

  test("completes an async local-only result after the settle window", async () => {
    const scheduler = new ManualNoTurnScheduler();
    const omp = new OmpHarness({ noTurnScheduler: scheduler });
    await omp.start();
    const prompt = await omp.startPromptWithFalseLocalOnlyResult("local-only");

    expect(prompt.completed()).toBe(false);
    scheduler.settle();
    await expect(prompt.completion).resolves.toMatchObject({ finalText: "" });
    expect(omp.completedTurnCount()).toBe(1);
  });

  test("cancels an async local-only settle when the OMP session closes", async () => {
    const scheduler = new ManualNoTurnScheduler();
    const omp = new OmpHarness({ noTurnScheduler: scheduler });
    await omp.start();
    const prompt = await omp.startPromptWithFalseLocalOnlyResult("local-only");

    await omp.close();

    expect(scheduler.wasAborted()).toBe(true);
    expect(prompt.completed()).toBe(false);
    expect(omp.completedTurnCount()).toBe(0);
  });

  test("preserves a correlated invoked result over a local-only prompt ack", async () => {
    const omp = new OmpHarness();
    await omp.start();

    const completion = await omp.runPromptAfterCorrelatedTrueResult(
      "hello OMP",
      "correlated model turn completed",
    );

    expect(completion.completedBeforeTurn).toBe(false);
    expect(completion.result).toMatchObject({ finalText: "correlated model turn completed" });
    expect(omp.completedTurnCount()).toBe(1);
  });

  test("completes an autonomous OMP turn without a foreground turn ID", async () => {
    const omp = new OmpHarness();
    await omp.start();

    await omp.runAutonomousTurn("autonomous turn completed");

    expect(omp.completedTurnCount()).toBe(1);
    expect(omp.timeline()).toContainEqual({
      type: "assistant_message",
      text: "autonomous turn completed",
      messageId: "omp-assistant-1",
    });
  });

  test("resumes an OMP session and replays its history", async () => {
    const omp = new OmpHarness();
    await omp.resume(
      {
        user: { id: "user-history", text: "continue the audit" },
        assistant: { id: "assistant-history", text: "audit context restored" },
      },
      { cwd: "/workspace/resumed", modeId: "ask", thinkingOptionId: "high" },
    );

    expect(omp.launchConfiguration()).toEqual({
      cwd: "/workspace/resumed",
      protocolMode: "rpc-ui",
      modeId: "ask",
      session: expect.stringMatching(/[\\/]paseo-omp-resume-.*[\\/]session\.jsonl$/),
      argv: [
        "omp",
        "--mode",
        "rpc-ui",
        "--approval-mode",
        "always-ask",
        "--thinking",
        "high",
        "--session",
        expect.stringMatching(/[\\/]paseo-omp-resume-.*[\\/]session\.jsonl$/),
      ],
    });
    await expect(omp.history()).resolves.toEqual([
      { type: "user_message", text: "continue the audit", messageId: "user-history" },
      {
        type: "assistant_message",
        text: "audit context restored",
        messageId: "assistant-history",
      },
    ]);
  });

  test("maps permissions and sends the selected OMP response", async () => {
    const omp = new OmpHarness();
    await omp.start();

    omp.requestToolApproval({ id: "approval-1", tool: "bash", detail: "git status" });
    expect(omp.pendingPermissions()).toEqual([
      expect.objectContaining({ id: "approval-1", name: "bash", kind: "tool" }),
    ]);

    await omp.respondToPermission("approval-1", { behavior: "allow" });
    expect(omp.extensionUiResponses()).toEqual([
      { id: "approval-1", response: { value: "Approve" } },
    ]);
  });

  test("exposes OMP modes and commands through the domain session", async () => {
    const omp = new OmpHarness();
    omp.queueCommands([{ name: "review", description: "Review changes", source: "skill" }]);
    await omp.start();

    await expect(omp.availableModes()).resolves.toEqual([
      expect.objectContaining({ id: "full" }),
      expect.objectContaining({ id: "write" }),
      expect.objectContaining({ id: "ask" }),
    ]);
    await expect(omp.commands()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "handoff" }),
        expect.objectContaining({ name: "review", kind: "skill" }),
      ]),
    );
    await expect(omp.setMode("ask")).resolves.toEqual({
      type: "warning",
      message: "Start a new OMP session to change approval mode",
    });
  });

  test("rewinds natively, interrupts, and shuts down", async () => {
    const omp = new OmpHarness();
    await omp.start();

    await omp.rewind("user-history", "from history");
    expect(omp.branchRequests()).toEqual(["user-history"]);

    await omp.interruptActiveTurn("stop me");
    expect(omp.wasAborted()).toBe(true);
    expect(omp.canceledTurnCount()).toBe(1);

    await omp.close();
    expect(omp.isClosed()).toBe(true);
  });

  test("interrupt terminalizes in-flight tool calls and running subagents", async () => {
    const omp = new OmpHarness();
    await omp.start();

    await omp.requireStartTurn("run something slow");
    const runtime = omp.runtime();
    runtime.beginTurn();
    runtime.emit({
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "bash",
      args: { command: "sleep 30" },
    });
    runtime.emit({
      type: "subagent_lifecycle",
      payload: {
        id: "child-1",
        agent: "worker",
        status: "started",
        parentToolCallId: "tool-1",
        index: 0,
      },
    });
    expect(omp.runningToolCallIds()).toEqual(["tool-1"]);
    expect(omp.subagentUpserts()).toEqual([{ id: "child-1", status: "running" }]);

    await omp.interrupt();

    expect(omp.canceledTurnCount()).toBe(1);
    expect(omp.runningToolCallIds()).toEqual([]);
    expect(omp.subagentUpserts()).toEqual([
      { id: "child-1", status: "running" },
      { id: "child-1", status: "canceled" },
    ]);

    // Late progress after interrupt must not resurrect a running card.
    runtime.emit({
      type: "subagent_progress",
      payload: {
        id: "child-1",
        agent: "worker",
        index: 0,
        progress: { id: "child-1", status: "running" },
        parentToolCallId: "tool-1",
      },
    });
    expect(omp.runningToolCallIds()).toEqual([]);
  });

  test("a resumed session does not re-emit replayed events as live timeline items", async () => {
    const omp = new OmpHarness();
    await omp.resume({
      user: { id: "user-history", text: "continue the audit" },
      assistant: { id: "assistant-history", text: "audit context restored" },
    });

    const runtime = omp.runtime();
    // OMP replays pre-existing conversation on startup with --session.
    runtime.acceptPrompt("continue the audit", "user-history");
    runtime.streamAssistantText("audit context restored", "assistant-history");
    expect(omp.timeline()).toEqual([]);

    // The first live prompt flows normally.
    await expect(omp.runPrompt("next step", "on it")).resolves.toMatchObject({
      finalText: "on it",
    });
    expect(omp.timeline()).toEqual([
      { type: "user_message", text: "next step", messageId: "user-1" },
      { type: "assistant_message", text: "on it", messageId: "omp-assistant-1" },
    ]);
  });

  test("re-emitted user message_end frames dedupe by native entry id", async () => {
    const omp = new OmpHarness();
    await omp.start();

    await expect(omp.runPrompt("hello OMP", "hello from OMP")).resolves.toMatchObject({
      finalText: "hello from OMP",
    });
    // OMP can re-send message_end for an entry it already surfaced.
    omp.runtime().acceptPrompt("hello OMP", "user-1");
    expect(omp.timeline().filter((item) => item.type === "user_message")).toEqual([
      { type: "user_message", text: "hello OMP", messageId: "user-1" },
    ]);
  });
});
