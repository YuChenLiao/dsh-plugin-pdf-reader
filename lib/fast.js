// src/engines/fast.ts
import { dirname as dirname2, isAbsolute, resolve as resolvePath } from "node:path";

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

// src/upstream.ts
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { buildArgs } from "@opendataloader/pdf";
var UPSTREAM_VERSION = "2.5.20";
var PAGE_SEPARATOR = "<!-- PAGE %page-number% -->";
function parsePageRange(range, total) {
  const pages = /* @__PURE__ */ new Set();
  for (const part of range.split(",")) {
    const piece = part.trim();
    if (piece === "") continue;
    const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(piece);
    if (match === null) continue;
    const start = Math.max(1, Number.parseInt(match[1], 10));
    const end = Math.min(total, match[2] === void 0 ? start : Number.parseInt(match[2], 10));
    for (let page = start; page <= end; page += 1) pages.add(page);
  }
  return pages;
}
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

// src/engines/fast.ts
var name = "dsh-plugin-pdf-reader/fast";
function resolveFastConfig(raw) {
  const input = raw !== null && typeof raw === "object" ? raw : {};
  const javaBinary = typeof input.javaBinary === "string" && input.javaBinary.trim() !== "" ? input.javaBinary : "java";
  const timeoutMs = typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs) && input.timeoutMs > 0 ? input.timeoutMs : 12e4;
  return { enabled: input.enabled !== false, javaBinary, timeoutMs };
}
function createFastEngine(ctx, cfg, deps = {}) {
  const jarOf = deps.jarOf ?? resolveJarPath;
  const run = deps.run ?? ((spec) => runProcess(ctx, spec));
  return {
    name: "fast",
    priority: ENGINE_PRIORITY.fast,
    version: UPSTREAM_VERSION,
    async available(signal) {
      if (!cfg.enabled) return { ok: false, reason: "\u7EC4\u4EF6\u5DF2\u5173\u95ED\uFF08enabled: false\uFF09" };
      if (jarOf() === null) return { ok: false, reason: `\u672A\u5B89\u88C5 @opendataloader/pdf@${UPSTREAM_VERSION}` };
      const java = await detectJava(ctx, cfg.javaBinary, signal);
      if (!java.ok) return { ok: false, reason: java.reason ?? "Java \u4E0D\u53EF\u7528" };
      return { ok: true };
    },
    async convert(request) {
      const jar = jarOf();
      if (jar === null) throw new EngineError("unavailable", `\u672A\u5B89\u88C5 @opendataloader/pdf@${UPSTREAM_VERSION}`);
      const input = isAbsolute(request.absPath) ? request.absPath : resolvePath(request.absPath);
      const result = await run({
        argv: buildConvertArgv(cfg.javaBinary, jar, { input, ...request.pages === void 0 ? {} : { pages: request.pages } }),
        cwd: dirname2(input),
        timeoutMs: cfg.timeoutMs,
        signal: request.signal,
        // 24MB jar 起 JVM 后被杀要给足回收时间，避免留下半个 java
        graceMs: 5e3
      });
      if (result.aborted) throw new EngineError("aborted", "\u8F6C\u6362\u88AB\u53D6\u6D88");
      if (result.timedOut) throw new EngineError("timeout", `fast \u5F15\u64CE\u8F6C\u6362\u8D85\u65F6\uFF08${cfg.timeoutMs}ms\uFF09`);
      if (result.code !== 0) {
        const failure = classifyFailure(result);
        throw new EngineError(failure.kind, failure.message);
      }
      if (result.stdout.trim() === "") throw new EngineError("engine-error", "\u8F6C\u6362\u6210\u529F\u4F46\u6CA1\u6709\u4EFB\u4F55\u8F93\u51FA\uFF08\u7591\u4F3C\u626B\u63CF\u4EF6\u6216\u7A7A\u6587\u6863\uFF09");
      return { markdown: result.stdout, engine: "fast", engineVersion: UPSTREAM_VERSION, degraded: false };
    }
  };
}
function apply(ctx, config) {
  const cfg = resolveFastConfig(config);
  attachEngine(ctx, () => createFastEngine(ctx, cfg));
}
export {
  PAGE_SEPARATOR,
  UPSTREAM_VERSION,
  apply,
  buildConvertArgv,
  classifyFailure,
  createFastEngine,
  name,
  parsePageRange,
  resolveFastConfig,
  resolveJarPath
};
