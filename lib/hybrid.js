// src/engines/hybrid.ts
import { connect } from "node:net";
import { readFile as readFile2, writeFile as writeFile2, mkdir as mkdir2 } from "node:fs/promises";
import { dirname as pathDirname, isAbsolute, join as join3, resolve as resolvePath2 } from "node:path";

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
    const outRead = handle.collected.stdout?.readFrom(0);
    const errRead = handle.collected.stderr?.readFrom(0);
    return {
      code,
      stdout: outRead?.text ?? "",
      stderr: errRead?.text ?? "",
      // 采集窗口滑出尾部意味着**开头丢了**：正文会缺页、页码会错位，必须让调用方知道
      stdoutLossy: outRead?.lossy === true,
      timedOut,
      aborted: spec.signal?.aborted === true
    };
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
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    const append = (target, chunk) => {
      const used = target === "stdout" ? stdoutBytes : stderrBytes;
      if (used >= maxBytes) return;
      const text = chunk.toString("utf8");
      if (target === "stdout") {
        stdout += text;
        stdoutBytes += chunk.length;
      } else {
        stderr += text;
        stderrBytes += chunk.length;
      }
    };
    const appendStdout = (chunk) => append("stdout", chunk);
    const appendStderr = (chunk) => append("stderr", chunk);
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
      resolve({ code, stdout, stderr, stdoutLossy: false, timedOut, aborted: spec.signal?.aborted === true });
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

// src/upstream.ts
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { buildArgs } from "@opendataloader/pdf";
var UPSTREAM_VERSION = "2.5.20";
var PAGE_SEPARATOR = "<!-- PAGE %page-number% -->";
var JAR_NAME = "opendataloader-pdf-cli.jar";
function resolveJarPath() {
  try {
    const require2 = createRequire(import.meta.url);
    const entry = require2.resolve("@opendataloader/pdf");
    const jar = join(dirname(entry), "..", "lib", JAR_NAME);
    return existsSync(jar) ? jar : null;
  } catch {
    return null;
  }
}
function buildConvertArgv(javaBinary, jarPath, request) {
  const upstream = buildArgs({
    format: "markdown",
    markdownPageSeparator: PAGE_SEPARATOR,
    imageOutput: "off",
    toStdout: true,
    ...request.pages === void 0 ? {} : { pages: request.pages },
    ...request.extra ?? {}
  });
  return [
    javaBinary,
    "-Dfile.encoding=UTF-8",
    "-Djava.awt.headless=true",
    "-jar",
    jarPath,
    request.input,
    ...upstream
  ];
}
var STDERR_TAIL = 2048;
function classifyFailure(result) {
  const text = `${result.stderr}
${result.stdout}`;
  const tail = result.stderr.trim().slice(-STDERR_TAIL);
  if (/File or folder .* not found|No such file/i.test(text)) return { kind: "missing-file", message: `\u8DEF\u5F84\u4E0D\u5B58\u5728\uFF1A${tail}` };
  if (/is not a PDF file/i.test(text)) return { kind: "not-pdf", message: `\u4E0D\u662F PDF \u6587\u4EF6\uFF1A${tail}` };
  if (/not a valid PDF file|corrupted or truncated/i.test(text)) return { kind: "corrupted", message: `PDF \u635F\u574F\u6216\u622A\u65AD\uFF1A${tail}` };
  if (/password|encrypted/i.test(text)) return { kind: "encrypted", message: `PDF \u5DF2\u52A0\u5BC6\uFF0C\u9700\u8981\u5BC6\u7801\uFF1A${tail}` };
  return { kind: "engine-error", message: `\u4E0A\u6E38 CLI \u9000\u51FA\u7801 ${result.code ?? "null"}\uFF1A${tail}` };
}

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

// src/cache.ts
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join as join2, resolve as resolvePath } from "node:path";
function expandHome(input) {
  if (!input.startsWith("~")) return resolvePath(input);
  const home = process.env.DSH_HOME ?? homedir();
  return resolvePath(`${home}${input.slice(1)}`);
}

// src/engines/attach.ts
function attachEngine(ctx, make) {
  let disposeEngine = null;
  let timer = null;
  const registryOf = () => {
    const candidate = ctx.get?.("pdfEngines");
    if (candidate !== null && typeof candidate === "object" && typeof candidate.register === "function") {
      return candidate;
    }
    return void 0;
  };
  const registry = registryOf();
  if (registry !== void 0) {
    disposeEngine = registry.register(make());
    ctx.effect?.(() => () => disposeEngine?.());
    return;
  }
  let tries = 0;
  timer = setInterval(() => {
    tries += 1;
    const late = registryOf();
    if (late !== void 0) {
      if (timer !== null) clearInterval(timer);
      timer = null;
      disposeEngine = late.register(make());
      return;
    }
    if (tries >= 20) {
      if (timer !== null) clearInterval(timer);
      timer = null;
      const log = typeof ctx.logger === "function" ? ctx.logger("pdf-reader") : void 0;
      log?.warn("\u672A\u627E\u5230 ctx.pdfEngines\uFF1A\u5DE5\u5177\u5C42\u7EC4\u4EF6\u6CA1\u6709\u88C5\u8F7D\uFF0C\u672C\u5F15\u64CE\u4E0D\u751F\u6548");
    }
  }, 100);
  timer.unref?.();
  ctx.effect?.(() => () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
    disposeEngine?.();
    disposeEngine = null;
  });
}

// src/engines/hybrid.ts
var name = "dsh-plugin-pdf-reader/hybrid";
var BACKEND_BINARY = "opendataloader-pdf-hybrid";
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
      'hybrid \u5F15\u64CE\u9700\u8981\u672C\u673A\u5177\u5907 docling \u540E\u7AEF\uFF1A\u5148\u6267\u884C pip install "opendataloader-pdf[hybrid]"\uFF08\u4F1A\u8FDE\u5E26\u88C5 docling \u4E0E\u4F9D\u8D56\uFF09\uFF0C\u9996\u6B21\u8F6C\u6362\u4E0B\u8F7D\u6570\u767E MB \u6A21\u578B\uFF0C\u5E76\u5E38\u9A7B\u4E00\u4E2A\u540E\u7AEF\u8FDB\u7A0B\uFF08\u9ED8\u8BA4\u7AEF\u53E3 5002\uFF09\u3002\u540C\u610F\u8FD9\u4E9B\u4E4B\u540E\uFF0C\u628A\u672C\u7EC4\u4EF6 config.acceptModelDownload \u8BBE\u4E3A true \u5E76\u91CD\u542F\u3002\u82E5\u5DF2\u6709\u81EA\u5EFA\u540E\u7AEF\uFF0C\u586B hybridUrl \u5373\u53EF\u8DF3\u8FC7\u81EA\u52A8\u542F\u52A8\u3002'
    );
  }
  const port = typeof input.port === "number" && Number.isInteger(input.port) && input.port > 0 && input.port < 65536 ? input.port : 5002;
  const timeoutMs = typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs) && input.timeoutMs > 0 ? input.timeoutMs : 6e5;
  const startTimeoutMs = typeof input.startTimeoutMs === "number" && Number.isFinite(input.startTimeoutMs) && input.startTimeoutMs > 0 ? input.startTimeoutMs : 3e5;
  const healthTimeoutMs = typeof input.healthTimeoutMs === "number" && Number.isFinite(input.healthTimeoutMs) && input.healthTimeoutMs > 0 ? input.healthTimeoutMs : 1500;
  return {
    enabled,
    acceptModelDownload,
    port,
    autoStart: input.autoStart !== false,
    ...typeof input.hybridUrl === "string" && input.hybridUrl.trim() !== "" ? { hybridUrl: input.hybridUrl.trim() } : {},
    timeoutMs,
    startTimeoutMs,
    healthTimeoutMs,
    javaBinary: typeof input.javaBinary === "string" && input.javaBinary.trim() !== "" ? input.javaBinary : "java",
    backendBinary: typeof input.backendBinary === "string" && input.backendBinary.trim() !== "" ? input.backendBinary : BACKEND_BINARY,
    backendArgs: Array.isArray(input.backendArgs) ? input.backendArgs.filter((item) => typeof item === "string" && item.trim() !== "") : []
  };
}
function backendUrlOf(cfg) {
  return cfg.hybridUrl ?? `http://127.0.0.1:${cfg.port}`;
}
function probePort(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}
var defaultSleep = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});
function createHybridEngine(ctx, cfg, deps = {}) {
  const jarOf = deps.jarOf ?? resolveJarPath;
  const run = deps.run ?? ((spec) => runProcess(ctx, spec));
  const probe = deps.probe ?? probePort;
  const sleep = deps.sleep ?? defaultSleep;
  const stateFile = deps.stateFile ?? join3(expandHome("~/.dsh/pdf-cache"), ".hybrid-state.json");
  const startBackend = deps.startBackend ?? ((config) => spawnBackend(ctx, config));
  let backend = null;
  let starting = null;
  const target = () => {
    const url = backendUrlOf(cfg);
    try {
      const parsed = new URL(url);
      return { host: parsed.hostname, port: Number(parsed.port === "" ? parsed.protocol === "https:" ? 443 : 80 : parsed.port) };
    } catch {
      return { host: "127.0.0.1", port: cfg.port };
    }
  };
  const isRemote = () => cfg.hybridUrl !== void 0;
  const writeState = async (state) => {
    await mkdir2(pathDirname(stateFile), { recursive: true }).catch(() => void 0);
    await writeFile2(stateFile, JSON.stringify(state, null, 2), "utf8").catch(() => void 0);
  };
  const ensureBackend = () => {
    starting ??= (async () => {
      const { host, port } = target();
      if (await probe(host, port, cfg.healthTimeoutMs)) return true;
      if (isRemote() || !cfg.autoStart) {
        await writeState({ status: "failed", port, startedAt: (/* @__PURE__ */ new Date()).toISOString(), detail: isRemote() ? "\u8FDC\u7A0B\u540E\u7AEF\u4E0D\u53EF\u8FBE" : "autoStart \u5DF2\u5173\u95ED" });
        return false;
      }
      await writeState({ status: "starting", port, startedAt: (/* @__PURE__ */ new Date()).toISOString() });
      try {
        backend = startBackend(cfg);
      } catch (error) {
        await writeState({ status: "failed", port, startedAt: (/* @__PURE__ */ new Date()).toISOString(), detail: error instanceof Error ? error.message : String(error) });
        return false;
      }
      const deadline = Date.now() + cfg.startTimeoutMs;
      while (Date.now() < deadline) {
        await sleep(1e3);
        if (await probe(host, port, cfg.healthTimeoutMs)) {
          await writeState({ status: "ready", port, startedAt: (/* @__PURE__ */ new Date()).toISOString() });
          return true;
        }
      }
      await writeState({ status: "failed", port, startedAt: (/* @__PURE__ */ new Date()).toISOString(), detail: `\u540E\u7AEF\u5728 ${cfg.startTimeoutMs}ms \u5185\u672A\u5C31\u7EEA` });
      return false;
    })();
    return starting;
  };
  return {
    name: "hybrid",
    priority: ENGINE_PRIORITY.hybrid,
    // 实测 8–10s/页（扫描件 + OCR 约 25s/页）：只接受显式调用，不进自动链
    explicitOnly: true,
    version: UPSTREAM_VERSION,
    // 换了后端参数（例如开 --force-ocr）就该是另一份缓存（code review I2）
    cacheSignature: JSON.stringify({ url: backendUrlOf(cfg), args: cfg.backendArgs }),
    async available(signal) {
      if (!cfg.enabled) return { ok: false, reason: "\u7EC4\u4EF6\u5DF2\u5173\u95ED\uFF08\u9ED8\u8BA4\u5173\u95ED\uFF09" };
      if (!cfg.acceptModelDownload) return { ok: false, reason: "\u672A\u540C\u610F\u6A21\u578B\u4E0B\u8F7D" };
      if (jarOf() === null) return { ok: false, reason: `\u672A\u5B89\u88C5 @opendataloader/pdf@${UPSTREAM_VERSION}` };
      const java = await detectJava(ctx, cfg.javaBinary, signal);
      if (!java.ok) return { ok: false, reason: java.reason ?? "Java \u4E0D\u53EF\u7528" };
      const { host, port } = target();
      if (await probe(host, port, cfg.healthTimeoutMs)) return { ok: true };
      void ensureBackend();
      return { ok: false, reason: "docling \u540E\u7AEF\u672A\u5C31\u7EEA\uFF08\u5DF2\u5728\u540E\u53F0\u542F\u52A8\uFF0C\u9996\u6B21\u9700\u4E0B\u8F7D\u6A21\u578B\uFF1B\u72B6\u6001\u89C1 ~/.dsh/pdf-cache/.hybrid-state.json\uFF09" };
    },
    async convert(request) {
      const jar = jarOf();
      if (jar === null) throw new EngineError("unavailable", `\u672A\u5B89\u88C5 @opendataloader/pdf@${UPSTREAM_VERSION}`);
      const { host, port } = target();
      if (!await probe(host, port, cfg.healthTimeoutMs)) {
        void ensureBackend();
        throw new EngineError("initializing", "docling \u540E\u7AEF\u8FD8\u5728\u521D\u59CB\u5316\uFF08\u9996\u6B21\u9700\u4E0B\u8F7D\u6A21\u578B\uFF09\u3002\u7A0D\u540E\u91CD\u8BD5\uFF0C\u6216\u5148\u8BA9 fast \u5F15\u64CE\u5904\u7406\u3002");
      }
      const input = isAbsolute(request.absPath) ? request.absPath : resolvePath2(request.absPath);
      const result = await run({
        argv: buildConvertArgv(cfg.javaBinary, jar, {
          input,
          ...request.pages === void 0 ? {} : { pages: request.pages },
          extra: { hybrid: "docling-fast", hybridUrl: backendUrlOf(cfg), hybridTimeout: String(cfg.timeoutMs) }
        }),
        cwd: pathDirname(input),
        timeoutMs: cfg.timeoutMs,
        signal: request.signal,
        graceMs: 1e4
      });
      if (result.aborted) throw new EngineError("aborted", "\u8F6C\u6362\u88AB\u53D6\u6D88");
      if (result.timedOut) throw new EngineError("timeout", `hybrid \u5F15\u64CE\u8F6C\u6362\u8D85\u65F6\uFF08${cfg.timeoutMs}ms\uFF09`);
      if (result.code !== 0) {
        const failure = classifyFailure(result);
        throw new EngineError(failure.kind, failure.message);
      }
      if (result.stdoutLossy === true) {
        throw new EngineError("engine-error", "hybrid \u5F15\u64CE\u8F93\u51FA\u8D85\u8FC7\u91C7\u96C6\u4E0A\u9650\uFF0C\u5F00\u5934\u5DF2\u4E22\u5931\uFF1B\u8BF7\u7528 pages \u5206\u6BB5\u63D0\u53D6");
      }
      if (result.stdout.trim() === "") throw new EngineError("engine-error", "\u8F6C\u6362\u6210\u529F\u4F46\u6CA1\u6709\u4EFB\u4F55\u8F93\u51FA\uFF08\u7591\u4F3C\u626B\u63CF\u4EF6\u6216\u7A7A\u6587\u6863\uFF09");
      return { markdown: result.stdout, engine: "hybrid", engineVersion: UPSTREAM_VERSION, degraded: false };
    },
    /** 注册表在卸载本引擎时调用：停掉自己拉起的后端（code review I3）。 */
    dispose() {
      backend?.stop();
      backend = null;
      starting = null;
    }
  };
}
function backendArgv(cfg) {
  return [cfg.backendBinary, "--port", String(cfg.port), ...cfg.backendArgs];
}
function spawnBackend(ctx, cfg) {
  const service = ctx.get?.("subprocess");
  if (service === void 0) throw new Error("\u6CA1\u6709 ctx.subprocess\uFF0C\u65E0\u6CD5\u62C9\u8D77 docling \u540E\u7AEF");
  const handle = service.spawn({
    argv: backendArgv(cfg),
    cwd: process.cwd(),
    stdio: { stdin: "ignore", stdout: "inherit", stderr: "inherit" },
    graceMs: 1e4
  });
  return { stop: () => handle.terminate() };
}
async function readHybridState(path) {
  const file = path ?? join3(expandHome("~/.dsh/pdf-cache"), ".hybrid-state.json");
  try {
    return JSON.parse(await readFile2(file, "utf8"));
  } catch {
    return null;
  }
}
function apply(ctx, config) {
  const cfg = resolveHybridConfig(config);
  attachEngine(ctx, () => createHybridEngine(ctx, cfg));
}
export {
  apply,
  backendArgv,
  backendUrlOf,
  createHybridEngine,
  name,
  probePort,
  readHybridState,
  resolveHybridConfig,
  resolveJarPath
};
