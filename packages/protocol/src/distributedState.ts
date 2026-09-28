export const SHARED_STATE_CONTRACT_VERSION = "0.1" as const;

export interface SharedTaskState {
  taskId: string;
  checkpoint: string;
  version: number;
  updatedBy: string;
}

export interface SharedStateStore {
  read(taskId: string): SharedTaskState | null;
  compareAndSet(expectedVersion: number | null, next: SharedTaskState): boolean;
}

export interface DurableMessage<T = unknown> {
  messageId: string;
  idempotencyKey: string;
  consumerGroup: string;
  traceId: string;
  checkpoint: string;
  payload: T;
}

export interface DurableMessageBus {
  publish<T>(message: DurableMessage<T>): void;
  consume<T, R>(consumerGroup: string, handler: (message: DurableMessage<T>) => R): Array<{ message: DurableMessage<T>; value: R; duplicate: boolean }>;
}

export class InMemorySharedStateStore implements SharedStateStore {
  readonly #states = new Map<string, SharedTaskState>();

  read(taskId: string): SharedTaskState | null {
    const state = this.#states.get(taskId);
    return state ? { ...state } : null;
  }

  compareAndSet(expectedVersion: number | null, next: SharedTaskState): boolean {
    const current = this.#states.get(next.taskId);
    const actual = current?.version ?? null;
    if (actual !== expectedVersion) return false;
    if (next.version !== (expectedVersion ?? 0) + 1) {
      throw new Error("STATE_VERSION_GAP");
    }
    this.#states.set(next.taskId, { ...next });
    return true;
  }
}

export class InMemoryAtLeastOnceBus implements DurableMessageBus {
  readonly #messages: DurableMessage[] = [];
  readonly #completed = new Map<string, unknown>();

  publish<T>(message: DurableMessage<T>): void {
    this.#messages.push(message as DurableMessage);
  }

  redeliver(messageId: string): void {
    const message = this.#messages.find((item) => item.messageId === messageId);
    if (!message) throw new Error("MESSAGE_NOT_FOUND");
    this.#messages.push(message);
  }

  consume<T, R>(
    consumerGroup: string,
    handler: (message: DurableMessage<T>) => R,
  ): Array<{ message: DurableMessage<T>; value: R; duplicate: boolean }> {
    const results: Array<{ message: DurableMessage<T>; value: R; duplicate: boolean }> = [];
    for (const raw of this.#messages) {
      if (raw.consumerGroup !== consumerGroup) continue;
      const message = raw as DurableMessage<T>;
      const key = `${consumerGroup}:${message.idempotencyKey}`;
      if (this.#completed.has(key)) {
        results.push({ message, value: this.#completed.get(key) as R, duplicate: true });
        continue;
      }
      const value = handler(message);
      this.#completed.set(key, value);
      results.push({ message, value, duplicate: false });
    }
    return results;
  }
}
