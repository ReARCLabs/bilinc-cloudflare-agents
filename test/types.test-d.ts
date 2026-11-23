// Compiled by `npm run typecheck` (tsconfig includes test/); vitest does not run this file.
// `doStorage` mirrors DurableObjectStorage's get/put/delete/list; the real type is proved by the template's typecheck (T12).
import type { ContextConfig, SearchProvider } from "agents/context";
import type { ToolSet } from "ai";
import { expectTypeOf } from "vitest";
import { createBilinc } from "../src/index";
import type { Bilinc } from "../src/index";
import type { BilincMemoryProvider } from "../src/provider";
import { bilincTools } from "../src/tools";
import type { BilincToolStore } from "../src/tools";

declare const bilinc: Bilinc;
declare const doStorage: {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T = unknown>(options?: { prefix?: string; limit?: number }): Promise<Map<string, T>>;
};

expectTypeOf<BilincMemoryProvider>().toExtend<SearchProvider>();
expectTypeOf(bilinc.memoryBlock()).toEqualTypeOf<ContextConfig>();
expectTypeOf(bilinc.prefix).toEqualTypeOf<string>();
expectTypeOf(createBilinc).returns.toEqualTypeOf<Bilinc>();
expectTypeOf(bilincTools({ bilinc, store: doStorage })).toEqualTypeOf<ToolSet>();
expectTypeOf(doStorage).toExtend<BilincToolStore>();
expectTypeOf<ReturnType<typeof bilincTools>>().not.toExtend<Promise<unknown>>();
