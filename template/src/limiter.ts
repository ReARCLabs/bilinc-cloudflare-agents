import { DurableObject } from "cloudflare:workers";

// Stub so the Worker builds; Task 10 replaces it.
export class UnlockLimiter extends DurableObject<Env> {}
