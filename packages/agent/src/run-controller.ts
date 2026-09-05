import type { Agent, AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";

export interface AgentRunQueueState {
  readonly queued: number;
  readonly heldAfterInterrupt: boolean;
}

type AgentRunQueueListener = (state: AgentRunQueueState) => void;

function queuedUserMessage(text: string): AgentMessage {
  if (typeof text !== "string" || text.trim() === "") {
    throw new Error("cave_agent_queue_message_required");
  }
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  };
}

/**
 * One kernel-owned control handle for an active Pi loop.
 *
 * Messages queued before Pi is constructed are retained and attached once the
 * run starts. Queue state is observable without exposing Pi's private queues,
 * and one-at-a-time draining keeps the visible count exact at turn boundaries.
 */
export class AgentRunController {
  private agent: Agent | undefined;
  private steering: AgentMessage[] = [];
  private followUps: AgentMessage[] = [];
  private listeners = new Set<AgentRunQueueListener>();
  private seenTurnStart = false;
  private heldAfterInterrupt = false;

  get state(): AgentRunQueueState {
    return Object.freeze({
      queued: this.steering.length + this.followUps.length,
      heldAfterInterrupt: this.heldAfterInterrupt,
    });
  }

  subscribe(listener: AgentRunQueueListener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  steer(text: string): void {
    const message = queuedUserMessage(text);
    this.steering.push(message);
    this.agent?.steer(message);
    this.emit();
  }

  followUp(text: string): void {
    const message = queuedUserMessage(text);
    this.followUps.push(message);
    this.agent?.followUp(message);
    this.emit();
  }

  clear(index?: number): void {
    if (index === undefined) {
      this.steering = [];
      this.followUps = [];
      this.agent?.clearAllQueues();
      this.emit();
      return;
    }
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.state.queued) {
      throw new Error("cave_agent_queue_index_invalid");
    }
    if (index < this.steering.length) this.steering.splice(index, 1);
    else this.followUps.splice(index - this.steering.length, 1);
    // Pi exposes clearing, not indexed removal. Rebuild both queues from the
    // controller's authoritative ordered copies.
    if (this.agent !== undefined) {
      this.agent.clearAllQueues();
      for (const message of this.steering) this.agent.steer(message);
      for (const message of this.followUps) this.agent.followUp(message);
    }
    this.emit();
  }

  /** Abort active work while retaining queued messages for the next run. */
  interrupt(): void {
    this.heldAfterInterrupt = this.state.queued > 0;
    this.agent?.abort();
    this.emit();
  }

  /** Release retained messages so a subsequent run can drain them. */
  resume(): void {
    this.heldAfterInterrupt = false;
    this.emit();
  }

  /** Runtime hook. Not exported from package entry points. */
  _attach(agent: Agent): void {
    if (this.agent !== undefined && this.agent !== agent) {
      throw new Error("cave_agent_controller_in_use");
    }
    this.agent = agent;
    this.seenTurnStart = false;
    agent.steeringMode = "one-at-a-time";
    agent.followUpMode = "one-at-a-time";
    for (const message of this.steering) agent.steer(message);
    for (const message of this.followUps) agent.followUp(message);
    this.emit();
  }

  /** Runtime hook. Keeps undrained messages for a retry or resumed run. */
  _detach(agent: Agent): void {
    if (this.agent !== agent) return;
    this.agent = undefined;
    this.seenTurnStart = false;
  }

  /** Runtime hook: Pi drains one queued message immediately before next turn. */
  _observe(event: AgentEvent): void {
    if (event.type !== "turn_start") return;
    if (!this.seenTurnStart) {
      this.seenTurnStart = true;
      return;
    }
    if (this.steering.length > 0) this.steering.shift();
    else if (this.followUps.length > 0) this.followUps.shift();
    this.heldAfterInterrupt = false;
    this.emit();
  }

  private emit(): void {
    const snapshot = this.state;
    for (const listener of this.listeners) listener(snapshot);
  }
}
