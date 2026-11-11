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
function createEngineRegistry() {
  const engines = /* @__PURE__ */ new Map();
  const cache = /* @__PURE__ */ new Map();
  const inflight = /* @__PURE__ */ new Map();
  const check = (engine, signal) => {
    const cached = cache.get(engine.name);
    if (cached !== void 0) return Promise.resolve(cached);
    const running = inflight.get(engine.name);
    if (running !== void 0) return running;
    const pending = engine.available(signal).then((result) => {
      cache.set(engine.name, result);
      return result;
    }).catch((error) => {
      const result = { ok: false, reason: error instanceof Error ? error.message : String(error) };
      cache.set(engine.name, result);
      return result;
    }).finally(() => {
      inflight.delete(engine.name);
    });
    inflight.set(engine.name, pending);
    return pending;
  };
  const sorted = () => [...engines.values()].sort((a, b) => a.priority - b.priority);
  return {
    register(engine) {
      if (engines.has(engine.name)) throw new Error(`\u5F15\u64CE "${engine.name}" \u5DF2\u6CE8\u518C`);
      engines.set(engine.name, engine);
      cache.delete(engine.name);
      inflight.delete(engine.name);
      return () => {
        engines.delete(engine.name);
        cache.delete(engine.name);
        inflight.delete(engine.name);
      };
    },
    list() {
      return sorted();
    },
    async select(signal) {
      const reasons = [];
      for (const engine of sorted()) {
        const availability = await check(engine, signal);
        if (availability.ok) return engine;
        reasons.push(`${engine.name}: ${availability.reason ?? "\u4E0D\u53EF\u7528"}`);
      }
      throw new EngineError("unavailable", reasons.length === 0 ? "\u6CA1\u6709\u6CE8\u518C\u4EFB\u4F55\u5F15\u64CE" : `\u6CA1\u6709\u53EF\u7528\u5F15\u64CE\uFF08${reasons.join("\uFF1B")}\uFF09`);
    },
    async probe(signal) {
      const out = [];
      for (const engine of sorted()) {
        const availability = await check(engine, signal);
        out.push({
          name: engine.name,
          priority: engine.priority,
          version: engine.version,
          ok: availability.ok,
          ...availability.reason === void 0 ? {} : { reason: availability.reason }
        });
      }
      return out;
    }
  };
}

// src/proc.ts
import { spawn as spawnChild } from "node:child_process";
var DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
var DEFAULT_GRACE_MS = 2e3;
function subprocessOf(ctx) {
  const candidate = ctx.get?.("subprocess");
  if (candidate !== null && typeof candidate === "object" && typeof candidate.spawn === "function" && typeof candidate.resolveExecutable === "function") {
    return candidate;
  }
  return void 0;
}
async function runProcess(ctx, spec) {
  const service = subprocessOf(ctx);
  if (service !== void 0) return runViaService(service, spec);
  return runViaChildProcess(spec);
}
async function runViaService(service, spec) {
  const maxBytes = spec.maxBytes ?? DEFAULT_MAX_BYTES;
  const controller = new AbortController();
  const abortOuter = () => controller.abort();
  if (spec.signal?.aborted === true) controller.abort();
  else spec.signal?.addEventListener("abort", abortOuter, { once: true });
  let timedOut = false;
  const timer = spec.timeoutMs === void 0 ? void 0 : setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, spec.timeoutMs);
  try {
    const handle = service.spawn({
      argv: spec.argv,
      cwd: spec.cwd,
      stdio: { stdin: "ignore", stdout: { maxBytes }, stderr: { maxBytes } },
      graceMs: spec.graceMs ?? DEFAULT_GRACE_MS,
      signal: controller.signal
    });
    let code = null;
    try {
      code = (await handle.done).exitCode;
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error));
    }
    await handle.waitForExit().catch(() => false);
    const stdout = handle.collected.stdout?.readFrom(0).text ?? "";
    const stderr = handle.collected.stderr?.readFrom(0).text ?? "";
    return { code, stdout, stderr, timedOut, aborted: spec.signal?.aborted === true };
  } finally {
    if (timer !== void 0) clearTimeout(timer);
    spec.signal?.removeEventListener("abort", abortOuter);
  }
}
function runViaChildProcess(spec) {
  return new Promise((resolve) => {
    const child = spawnChild(spec.argv[0], spec.argv.slice(1), {
      cwd: spec.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    const maxBytes = spec.maxBytes ?? DEFAULT_MAX_BYTES;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const appendStdout = (chunk) => {
      if (stdout.length < maxBytes) stdout += chunk.toString("utf8");
    };
    const appendStderr = (chunk) => {
      if (stderr.length < maxBytes) stderr += chunk.toString("utf8");
    };
    child.stdout?.on("data", appendStdout);
    child.stderr?.on("data", appendStderr);
    const kill = () => {
      if (process.platform === "win32") spawnChild("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
      else child.kill("SIGKILL");
    };
    const timer = spec.timeoutMs === void 0 ? void 0 : setTimeout(() => {
      timedOut = true;
      kill();
    }, spec.timeoutMs);
    const abortOuter = () => {
      kill();
    };
    if (spec.signal?.aborted === true) abortOuter();
    else spec.signal?.addEventListener("abort", abortOuter, { once: true });
    child.on("error", (error) => {
      if (timer !== void 0) clearTimeout(timer);
      spec.signal?.removeEventListener("abort", abortOuter);
      resolve({ code: null, stdout, stderr: `${stderr}${error.message}`, timedOut, aborted: spec.signal?.aborted === true });
    });
    child.on("close", (code) => {
      if (timer !== void 0) clearTimeout(timer);
      spec.signal?.removeEventListener("abort", abortOuter);
      resolve({ code, stdout, stderr, timedOut, aborted: spec.signal?.aborted === true });
    });
  });
}

// src/probe/java.ts
function parseJavaVersion(text) {
  const match = /version\s+"(\d+)(?:\.(\d+))?/i.exec(text) ?? /"?(\d+)\.(\d+)\./i.exec(text);
  if (match === null) return null;
  const major = Number.parseInt(match[1], 10);
  if (!Number.isFinite(major)) return null;
  if (major === 1) {
    const minor = Number.parseInt(match[2] ?? "", 10);
    return Number.isFinite(minor) ? minor : null;
  }
  return major;
}
async function detectJava(ctx, binary = "java", signal) {
  const result = await runProcess(ctx, { argv: [binary, "-version"], cwd: process.cwd(), timeoutMs: 1e4, ...signal === void 0 ? {} : { signal } });
  const raw = `${result.stdout}${result.stderr}`.trim();
  if (result.aborted) return { ok: false, binary, raw, reason: "\u63A2\u6D4B\u88AB\u53D6\u6D88" };
  if (result.timedOut) return { ok: false, binary, raw, reason: "java -version \u8D85\u65F6\uFF0810s\uFF09" };
  if (result.code === null) return { ok: false, binary, raw, reason: `\u627E\u4E0D\u5230\u53EF\u6267\u884C\u6587\u4EF6 "${binary}"` };
  if (result.code !== 0) return { ok: false, binary, raw, reason: `java -version \u9000\u51FA\u7801 ${result.code}` };
  const version = parseJavaVersion(raw);
  if (version === null) return { ok: false, binary, raw, reason: "\u65E0\u6CD5\u4ECE\u8F93\u51FA\u89E3\u6790 Java \u7248\u672C" };
  if (version < 17) return { ok: false, binary, version, raw, reason: `\u9700\u8981 Java 17+\uFF0C\u5F53\u524D ${version}` };
  return { ok: true, binary, version, raw };
}

// src/tools/ping.ts
function createPingTool(deps) {
  const schema = {
    type: "object",
    properties: {
      pong: { type: "boolean" },
      java: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          binary: { type: "string" },
          version: { type: "number" },
          reason: { type: "string" }
        },
        required: ["ok", "binary"]
      },
      engines: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            priority: { type: "number" },
            version: { type: "string" },
            ok: { type: "boolean" },
            reason: { type: "string" }
          },
          required: ["name", "priority", "version", "ok"]
        }
      }
    },
    required: ["pong", "java", "engines"]
  };
  return {
    name: "pdf_ping",
    description: 'PDF \u63D2\u4EF6\u81EA\u68C0\uFF1A\u8FD4\u56DE\u672C\u673A Java \u63A2\u6D4B\u7ED3\u679C\u4E0E\u5404\u5F15\u64CE\u53EF\u7528\u6027\u3002\u7528\u4E8E\u6392\u67E5"\u4E3A\u4EC0\u4E48\u6CA1\u8D70\u9884\u671F\u5F15\u64CE"\u3002',
    parameters: { type: "object", properties: {}, required: [] },
    output: {
      schema,
      render(_args, raw) {
        const value = raw;
        const java = value.java.ok ? `java=${value.java.version ?? "?"} (${value.java.binary})` : `java=\u4E0D\u53EF\u7528\uFF08${value.java.reason ?? "\u672A\u77E5\u539F\u56E0"}\uFF09`;
        const engines = value.engines.map((engine) => `${engine.name}:${engine.ok ? "ok" : `\u5173\u95ED\uFF08${engine.reason ?? "\u4E0D\u53EF\u7528"}\uFF09`}`).join(" \xB7 ");
        return [{ type: "text", text: `pong \xB7 ${java}
\u5F15\u64CE\uFF08\u4F18\u5148\u7EA7 ${Object.entries(ENGINE_PRIORITY).map(([k, v]) => `${k}=${v}`).join(" ")}\uFF09: ${engines || "(\u65E0)"}` }];
      }
    },
    async execute(_args, exec) {
      const java = await detectJava(deps.ctx, deps.javaBinary, exec.signal);
      const engines = await deps.registry.probe(exec.signal);
      const value = {
        pong: true,
        java: {
          ok: java.ok,
          binary: java.binary,
          ...java.version === void 0 ? {} : { version: java.version },
          ...java.reason === void 0 ? {} : { reason: java.reason }
        },
        engines: engines.map((engine) => ({
          name: engine.name,
          priority: engine.priority,
          version: engine.version,
          ok: engine.ok,
          ...engine.reason === void 0 ? {} : { reason: engine.reason }
        }))
      };
      return value;
    }
  };
}

// src/plugin.ts
var name = "dsh-plugin-pdf-reader";
var inject = ["tools"];
var CONFIG_DEFAULTS = {
  enabled: true,
  inlineLimit: 6e3,
  cacheDir: "~/.dsh/pdf-cache",
  judgeEnabled: false,
  javaBinary: "java"
};
var INLINE_HARD_CEILING = 8192;
var ConfigError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
  }
};
function asBoolean(value, key, fallback) {
  if (value === void 0) return fallback;
  if (typeof value !== "boolean") throw new ConfigError(`config.${key} \u5FC5\u987B\u662F\u5E03\u5C14\u503C`);
  return value;
}
function asString(value, key, fallback) {
  if (value === void 0) return fallback;
  if (typeof value !== "string" || value.trim() === "") throw new ConfigError(`config.${key} \u5FC5\u987B\u662F\u975E\u7A7A\u5B57\u7B26\u4E32`);
  return value;
}
function resolveConfig(raw) {
  if (raw === void 0 || raw === null) return { ...CONFIG_DEFAULTS };
  if (typeof raw !== "object" || Array.isArray(raw)) throw new ConfigError("config \u5FC5\u987B\u662F\u5BF9\u8C61");
  const input = raw;
  const inlineLimit = input.inlineLimit;
  if (inlineLimit !== void 0) {
    if (typeof inlineLimit !== "number" || !Number.isFinite(inlineLimit) || inlineLimit < 0) {
      throw new ConfigError("config.inlineLimit \u5FC5\u987B\u662F\u975E\u8D1F\u6570\u5B57");
    }
    if (inlineLimit > INLINE_HARD_CEILING) {
      throw new ConfigError(`config.inlineLimit \u4E0A\u9650\u662F ${INLINE_HARD_CEILING} \u5B57\u7B26\uFF1A\u8D85\u8FC7\u5B83\u4F1A\u88AB dsh \u7684 tool-result-pruner \u622A\u6210"\u5934+\u5C3E"\u5E76\u9759\u9ED8\u4E22\u6B63\u6587`);
    }
  }
  return {
    enabled: asBoolean(input.enabled, "enabled", CONFIG_DEFAULTS.enabled),
    inlineLimit: inlineLimit === void 0 ? CONFIG_DEFAULTS.inlineLimit : inlineLimit,
    cacheDir: asString(input.cacheDir, "cacheDir", CONFIG_DEFAULTS.cacheDir),
    judgeEnabled: asBoolean(input.judgeEnabled, "judgeEnabled", CONFIG_DEFAULTS.judgeEnabled),
    javaBinary: asString(input.javaBinary, "javaBinary", CONFIG_DEFAULTS.javaBinary)
  };
}
function apply(ctx, config) {
  const cfg = resolveConfig(config);
  if (!cfg.enabled) return;
  const registry = createEngineRegistry();
  ctx.provide?.("pdfEngines", registry);
  ctx.tools.register(createPingTool({ ctx, registry, javaBinary: cfg.javaBinary }));
  const logger = typeof ctx.logger === "function" ? ctx.logger("pdf-reader") : void 0;
  logger?.info(`\u5DE5\u5177\u5C42\u5DF2\u88C5\u8F7D\uFF08inlineLimit=${cfg.inlineLimit}, judgeEnabled=${cfg.judgeEnabled}\uFF09`);
}
export {
  CONFIG_DEFAULTS,
  ENGINE_PRIORITY,
  EngineError,
  apply,
  createEngineRegistry,
  createPingTool,
  detectJava,
  inject,
  name,
  parseJavaVersion,
  resolveConfig,
  runProcess
};
