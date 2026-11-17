import { pino, type LoggerOptions } from "pino";
import { env } from "./env.ts";

/**
 * Structured JSON logs (pino). Never log personal data or secrets: the redact
 * list below is a safety net, not a licence to pass them in.
 *
 * - production: JSON to stdout, level `info`
 * - development: pretty-printed, level `debug`
 * - test: silent (override with LOG_LEVEL)
 */
const defaultLevel = { production: "info", development: "debug", test: "silent" } as const;

export const REDACT_PATHS = [
  "password",
  "*.password",
  "token",
  "*.token",
  "accessToken",
  "refreshToken",
  "apiKey",
  "*.apiKey",
  "authorization",
  "*.authorization",
  "cookie",
  "*.cookie",
  "email",
  "*.email",
  "phone",
  "*.phone",
];

const options: LoggerOptions = {
  level: env.LOG_LEVEL ?? defaultLevel[env.NODE_ENV],
  base: { service: "dpdpa-api" },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: { paths: REDACT_PATHS, censor: "[redacted]" },
  ...(env.NODE_ENV === "development"
    ? { transport: { target: "pino-pretty", options: { translateTime: "SYS:HH:MM:ss", ignore: "pid,hostname,service" } } }
    : {}),
};

export const logger = pino(options);
