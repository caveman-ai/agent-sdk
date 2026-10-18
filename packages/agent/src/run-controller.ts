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
 * and Pi's message delivery events keep the visible count exact.
 */
export class AgentRunController {
  private agent: Agent | undefined;
  private steering: AgentMessage[] = [];
  private followUps: AgentMessage[] = [];
  private listeners = new Set<AgentRunQueueListener>();
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
    const message = [...this.steering, ...this.followUps][index]!;
    if (this.agent !== undefined && !this.removeQueuedMessage(this.agent, message)) {
      throw new Error("cave_agent_queue_message_in_flight");
    }
    if (index < this.steering.length) this.steering.splice(index, 1);
    else this.followUps.splice(index - this.steering.length, 1);
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
  }

  /** Runtime hook: acknowledge only messages Pi actually adds to the transcript. */
  _observe(event: AgentEvent): void {
    if (event.type !== "message_end" || event.message.role !== "user") return;
    // Tool turns need not drain follow-ups; steering can arrive before the
    // first request. Pi preserves queued message identity in delivery events.
    for (const queue of [this.steering, this.followUps]) {
      const index = queue.indexOf(event.message);
      if (index < 0) continue;
      queue.splice(index, 1);
      this.heldAfterInterrupt = false;
      this.emit();
      return;
    }
  }

  private removeQueuedMessage(agent: Agent, target: AgentMessage): boolean {
    // Pi may already have selected a message without emitting message_end.
    // Snapshot its actual queues through public APIs, synchronously: no loop
    // work can interleave while preview modes and the steering queue change.
    const steeringMode = agent.steeringMode;
    const followUpMode = agent.followUpMode;
    agent.steeringMode = "all";
    agent.followUpMode = "all";
    const first = agent.peekQueuedMessages();
    agent.clearSteeringQueue();
    const followUps = agent.peekQueuedMessages();
    const following = new Set(followUps);
    const steering = first.filter((message) => !following.has(message));
    agent.clearFollowUpQueue();
    agent.steeringMode = steeringMode;
    agent.followUpMode = followUpMode;
    for (const message of steering) if (message !== target) agent.steer(message);
    for (const message of followUps) if (message !== target) agent.followUp(message);
    return steering.includes(target) || following.has(target);
  }

  private emit(): void {
    const snapshot = this.state;
    for (const listener of this.listeners) listener(snapshot);
  }
}
