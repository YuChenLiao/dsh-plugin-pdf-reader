// src/engines/fallback.ts
import { createRequire } from "node:module";

// src/engines.ts
var ENGINE_PRIORITY = {
  hybrid: 10,
  fast: 20,
  fallback: 90
};
var EngineError = class extends Error {
  kind;
  constructor(kind, message) {
    super(message);
    this.name = "EngineError";
    this.kind = kind;
  }
};

// src/engines/attach.ts
function attachEngine(ctx, make) {
  const registryOf = () => {
    const candidate = ctx.get?.("pdfEngines");
    if (candidate !== null && typeof candidate === "object" && typeof candidate.register === "function") {
      return candidate;
    }
    return void 0;
  };
  const registry = registryOf();
  if (registry !== void 0) {
    registry.register(make());
    return;
  }
  let tries = 0;
  const timer = setInterval(() => {
    tries += 1;
    const late = registryOf();
    if (late !== void 0) {
      clearInterval(timer);
      late.register(make());
      return;
    }
    if (tries >= 20) {
      clearInterval(timer);
      const log = typeof ctx.logger === "function" ? ctx.logger("pdf-reader") : void 0;
      log?.warn("\u672A\u627E\u5230 ctx.pdfEngines\uFF1A\u5DE5\u5177\u5C42\u7EC4\u4EF6\u6CA1\u6709\u88C5\u8F7D\uFF0C\u672C\u5F15\u64CE\u4E0D\u751F\u6548");
    }
  }, 100);
  timer.unref?.();
}

// src/engines/fallback.ts
var name = "dsh-plugin-pdf-reader/fallback";
function resolveFallbackConfig(raw) {
  const input = raw !== null && typeof raw === "object" ? raw : {};
  const timeoutMs = typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs) && input.timeoutMs > 0 ? input.timeoutMs : 6e4;
  return { enabled: input.enabled !== false, timeoutMs };
}
function resolvePdfiumVersion() {
  try {
    const require2 = createRequire(import.meta.url);
    const pkg = require2("@hyzyla/pdfium/package.json");
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return null;
  }
}
function createFallbackEngine(cfg, versionOf = resolvePdfiumVersion) {
  return {
    name: "fallback",
    priority: ENGINE_PRIORITY.fallback,
    version: versionOf() ?? "unknown",
    async available() {
      if (!cfg.enabled) return { ok: false, reason: "\u7EC4\u4EF6\u5DF2\u5173\u95ED\uFF08enabled: false\uFF09" };
      if (versionOf() === null) return { ok: false, reason: "\u672A\u5B89\u88C5 @hyzyla/pdfium\uFF08\u9636\u6BB5 5 \u63A5\u5165\uFF09" };
      return { ok: false, reason: "\u515C\u5E95\u8F6C\u6362\u5728\u9636\u6BB5 5 \u5B9E\u73B0" };
    },
    async convert(_request) {
      throw new EngineError("unavailable", "fallback \u5F15\u64CE\u7684\u8F6C\u6362\u5728\u9636\u6BB5 5 \u5B9E\u73B0");
    }
  };
}
function apply(ctx, config) {
  const cfg = resolveFallbackConfig(config);
  attachEngine(ctx, () => createFallbackEngine(cfg));
}
export {
  apply,
  createFallbackEngine,
  name,
  resolveFallbackConfig,
  resolvePdfiumVersion
};
