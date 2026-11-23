export * from "./events.js";

export const PROTOCOL_VERSION = "1.0.0" as const;

export const HARNESS_EXIT_CODES = {
  ENDED: 0,
  ERROR: 1,
  USAGE: 2,
  BUDGET_REACHED: 3,
  TIME_LIMIT: 4,
  PARKED_WAITING: 5,
  PARKED_IDLE: 6,
} as const;

export type HarnessExitCode = (typeof HARNESS_EXIT_CODES)[keyof typeof HARNESS_EXIT_CODES];
