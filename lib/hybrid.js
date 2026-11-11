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

// src/engines/hybrid.ts
var name = "dsh-plugin-pdf-reader/hybrid";
var ConfigError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
  }
};
function resolveHybridConfig(raw) {
  const input = raw !== null && typeof raw === "object" ? raw : {};
  const enabled = input.enabled === true;
  const acceptModelDownload = input.acceptModelDownload === true;
  if (enabled && !acceptModelDownload) {
    throw new ConfigError(
      'hybrid \u5F15\u64CE\u9700\u8981\u672C\u673A\u5177\u5907 docling \u540E\u7AEF\uFF1A\u5148\u88C5 Python \u4F9D\u8D56\uFF08pip install "opendataloader-pdf[hybrid]"\uFF09\uFF0C\u9996\u6B21\u8F6C\u6362\u4F1A\u4E0B\u8F7D\u6570\u767E MB \u6A21\u578B\uFF0C\u5E76\u5E38\u9A7B\u4E00\u4E2A\u540E\u7AEF\u8FDB\u7A0B\uFF08\u9ED8\u8BA4\u7AEF\u53E3 5002\uFF09\u3002\u540C\u610F\u8FD9\u4E9B\u4E4B\u540E\uFF0C\u628A\u672C\u7EC4\u4EF6\u7684 config.acceptModelDownload \u8BBE\u4E3A true \u518D\u91CD\u542F\u3002\u82E5\u5DF2\u6709\u81EA\u5EFA\u540E\u7AEF\uFF0C\u586B hybridUrl \u5373\u53EF\u8DF3\u8FC7\u81EA\u52A8\u542F\u52A8\u3002'
    );
  }
  const port = typeof input.port === "number" && Number.isInteger(input.port) && input.port > 0 && input.port < 65536 ? input.port : 5002;
  const timeoutMs = typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs) && input.timeoutMs > 0 ? input.timeoutMs : 6e5;
  return {
    enabled,
    acceptModelDownload,
    port,
    autoStart: input.autoStart !== false,
    ...typeof input.hybridUrl === "string" && input.hybridUrl.trim() !== "" ? { hybridUrl: input.hybridUrl } : {},
    timeoutMs
  };
}
function createHybridEngine(cfg) {
  return {
    name: "hybrid",
    priority: ENGINE_PRIORITY.hybrid,
    version: "pending",
    async available() {
      if (!cfg.enabled) return { ok: false, reason: "\u7EC4\u4EF6\u5DF2\u5173\u95ED\uFF08\u9ED8\u8BA4\u5173\u95ED\uFF09" };
      if (!cfg.acceptModelDownload) return { ok: false, reason: "\u672A\u540C\u610F\u6A21\u578B\u4E0B\u8F7D" };
      return { ok: false, reason: "hybrid \u8F6C\u6362\u5728\u9636\u6BB5 6 \u5B9E\u73B0" };
    },
    async convert(_request) {
      throw new EngineError("unavailable", "hybrid \u5F15\u64CE\u7684\u8F6C\u6362\u5728\u9636\u6BB5 6 \u5B9E\u73B0");
    }
  };
}
function apply(ctx, config) {
  const cfg = resolveHybridConfig(config);
  attachEngine(ctx, () => createHybridEngine(cfg));
}
export {
  apply,
  createHybridEngine,
  name,
  resolveHybridConfig
};
