interface Env {
  AI: Ai;
  BilincAgent: DurableObjectNamespace<import("./src/agent").BilincAgent>;
  UNLOCK_LIMITER: DurableObjectNamespace<import("./src/limiter").UnlockLimiter>;
  BILINC_API_KEY: string;
  APP_ACCESS_TOKEN: string;
  MODEL: string;
  MODELS?: unknown;
  BILINC_NAMESPACE?: string;
  AUTO_CHECKPOINT?: string;
}
