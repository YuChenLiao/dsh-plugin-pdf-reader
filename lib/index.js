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
  const schema2 = {
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
      schema: schema2,
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

// src/tools/extract.ts
import { stat as stat2 } from "node:fs/promises";
import { isAbsolute, resolve as resolvePath2 } from "node:path";

// src/cache.ts
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
var HANDLE_LENGTH = 12;
var RECENT_LIMIT = 200;
function expandHome(input) {
  if (!input.startsWith("~")) return resolvePath(input);
  const home = process.env.DSH_HOME ?? homedir();
  return resolvePath(`${home}${input.slice(1)}`);
}
function paramsSignature(params) {
  return JSON.stringify({ pages: params.pages ?? "", separator: params.separator });
}
function cacheKey(fileSha256, engine, engineVersion, params) {
  return createHash("sha256").update(`${fileSha256}:${engine}:${engineVersion}:${paramsSignature(params)}`).digest("hex").slice(0, HANDLE_LENGTH);
}
async function sha256File(path) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve());
  });
  return hash.digest("hex");
}
var indexDir = (cacheDir) => join(cacheDir, "index");
var fileIndexPath = (cacheDir, fileSha256) => join(indexDir(cacheDir), `${fileSha256.slice(0, HANDLE_LENGTH)}.json`);
var recentPath = (cacheDir) => join(indexDir(cacheDir), "_recent.json");
async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}
async function writeJson(path, value) {
  await mkdir(join(path, ".."), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await rename(tmp, path);
}
async function writeEntry(cacheDir, entry) {
  const dir = join(cacheDir, entry.handle);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "body.md"), entry.body, "utf8");
  await writeJson(join(dir, "meta.json"), entry.meta);
  await writeJson(join(dir, "source.json"), {
    path: entry.meta.sourcePath,
    size: entry.meta.sourceSize,
    mtimeMs: entry.meta.sourceMtimeMs,
    sha256: entry.meta.fileSha256,
    params: entry.meta.params
  });
  const ref = {
    handle: entry.meta.handle,
    engine: entry.meta.engine,
    engineVersion: entry.meta.engineVersion,
    params: entry.meta.params,
    pages: entry.meta.pages,
    chars: entry.meta.chars,
    degraded: entry.meta.degraded,
    cachedAt: entry.meta.cachedAt
  };
  const indexPath = fileIndexPath(cacheDir, entry.meta.fileSha256);
  const index = await readJson(indexPath) ?? { fileSha256: entry.meta.fileSha256, entries: [] };
  index.entries = [...index.entries.filter((item) => item.handle !== ref.handle), ref];
  await writeJson(indexPath, index);
  const recent = await readJson(recentPath(cacheDir)) ?? [];
  await writeJson(recentPath(cacheDir), [ref, ...recent.filter((item) => item.handle !== ref.handle)].slice(0, RECENT_LIMIT));
}
async function lookupFile(cacheDir, fileSha256, params) {
  const index = await readJson(fileIndexPath(cacheDir, fileSha256));
  if (index === null) return null;
  const signature = paramsSignature(params);
  const matches = index.entries.filter((entry) => paramsSignature(entry.params) === signature);
  if (matches.length === 0) return null;
  matches.sort((a, b) => a.cachedAt < b.cachedAt ? 1 : a.cachedAt > b.cachedAt ? -1 : 0);
  return readEntry(cacheDir, matches[0].handle);
}
async function readEntry(cacheDir, handle) {
  const dir = join(cacheDir, handle);
  const meta = await readJson(join(dir, "meta.json"));
  if (meta === null) return null;
  const body = await readFile(join(dir, "body.md"), "utf8").catch(() => null);
  if (body === null) return null;
  return { dir, body, meta };
}
async function recentHandles(cacheDir, limit = 5) {
  const recent = await readJson(recentPath(cacheDir)) ?? [];
  return recent.slice(0, limit).map((entry) => entry.handle);
}

// src/metrics.ts
var CJK_ALL = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/g;
var PAGE_SEPARATOR = /<!--\s*PAGE\s+\d+\s*-->/g;
function splitPages(markdown) {
  const parts = markdown.split(PAGE_SEPARATOR);
  if (parts.length > 1 && parts[0]?.trim() === "") return parts.slice(1);
  return parts.length === 0 ? [""] : parts;
}
function ratio(part, whole) {
  return whole === 0 ? 0 : part / whole;
}
function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}
function countCjk(text) {
  return (text.match(CJK_ALL) ?? []).length;
}
function computeMetrics(markdown) {
  const text = markdown.replace(PAGE_SEPARATOR, "");
  const chars = text.length;
  const pageTexts = splitPages(markdown);
  const pageLengths = pageTexts.map((page) => page.trim().length);
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
  const nonSpace = text.replace(/\s/g, "");
  const replacementChars = (text.match(/\uFFFD/g) ?? []).length;
  let controlChars = 0;
  for (const char of text) {
    const code = char.codePointAt(0);
    const isControl = code < 32 && char !== "\n" && char !== "	" && char !== "\r" || code >= 127 && code <= 159;
    if (isControl) controlChars += 1;
  }
  const privateUse = (text.match(/[\uE000-\uF8FF]/g) ?? []).length;
  const questionRun = Math.max(0, ...(text.match(/\?+/g) ?? []).map((run) => run.length));
  const avgCharsPerLine = lines.length === 0 ? 0 : lines.reduce((sum, line) => sum + line.length, 0) / lines.length;
  const singleCharLines = lines.filter((line) => line.trim().length <= 1).length;
  const punctLines = lines.filter((line) => /[。．.！!？?；;:：]$/.test(line.trim())).length;
  const mean = pageLengths.length === 0 ? 0 : pageLengths.reduce((a, b) => a + b, 0) / pageLengths.length;
  const variance = pageLengths.length === 0 ? 0 : pageLengths.reduce((sum, value) => sum + (value - mean) ** 2, 0) / pageLengths.length;
  const cv = mean === 0 ? 0 : Math.sqrt(variance) / mean;
  const emptyPages = pageLengths.filter((length) => length < 20).length;
  const emptyPageRatio = ratio(emptyPages, pageLengths.length);
  const nonEmptyLengths = pageLengths.filter((length) => length >= 20);
  const pageMedian = median(nonEmptyLengths.length > 0 ? nonEmptyLengths : pageLengths);
  const lastPageRatio = pageMedian === 0 ? 0 : (pageLengths.at(-1) ?? 0) / pageMedian;
  const tableLines = text.split(/\r?\n/).filter((line) => /^\s*\|/.test(line)).length;
  const tables = tableLines > 0 ? text.split(/\r?\n/).reduce((count, line, index, all) => {
    const isRow = /^\s*\|/.test(line);
    const prevRow = index > 0 && /^\s*\|/.test(all[index - 1]);
    return isRow && !prevRow ? count + 1 : count;
  }, 0) : 0;
  const headings = (text.match(/^\s*#{1,6}\s+\S/gm) ?? []).length;
  return {
    chars,
    pages: pageTexts.length,
    replacement_ratio: ratio(replacementChars, chars),
    control_ratio: ratio(controlChars, chars),
    private_use_ratio: ratio(privateUse, chars),
    cjk_ratio: ratio(countCjk(nonSpace), nonSpace.length),
    question_run_max: questionRun,
    avg_chars_per_line: avgCharsPerLine,
    single_char_line_ratio: ratio(singleCharLines, lines.length),
    line_end_punct_ratio: ratio(punctLines, lines.length),
    page_char_variance: cv,
    empty_pages: emptyPages,
    empty_page_ratio: emptyPageRatio,
    last_page_ratio: lastPageRatio,
    tables,
    headings,
    image_only_hint: emptyPageRatio > 0.2 || pageTexts.length > 0 && chars / pageTexts.length < 100
  };
}
function estimateTokens(chars) {
  return Math.round(chars * 0.6);
}

// src/upstream.ts
import { existsSync } from "node:fs";
import { dirname, join as join2 } from "node:path";
import { createRequire } from "node:module";
import { buildArgs } from "@opendataloader/pdf";
var PAGE_SEPARATOR2 = "<!-- PAGE %page-number% -->";

// src/tools/extract.ts
var PARAMS_BASE = { separator: PAGE_SEPARATOR2 };
var schema = {
  type: "object",
  properties: {
    mode: { type: "string" },
    engine: { type: "string" },
    degraded: { type: "boolean" },
    handle: { type: "string" },
    verdict: { type: "string" },
    pages: { type: "number" },
    chars: { type: "number" },
    tokens_est: { type: "number" },
    stats: { type: "object" },
    issues: { type: "array", items: { type: "string" } },
    suggest: { type: "string" },
    content: { type: "string" }
  },
  required: ["mode", "engine", "degraded", "handle", "verdict", "pages", "chars"]
};
function resolveInputPath(input) {
  if (input.startsWith("~")) return expandHome(input);
  return isAbsolute(input) ? input : resolvePath2(process.cwd(), input);
}
function spillOrInline(chars, inlineLimit) {
  if (inlineLimit === 0) return "spilled";
  return chars <= inlineLimit ? "inline" : "spilled";
}
function toValue(meta, body, inlineLimit) {
  const mode = spillOrInline(meta.chars, inlineLimit);
  const value = {
    mode,
    engine: meta.engine,
    degraded: meta.degraded,
    handle: meta.handle,
    verdict: meta.verdict ?? "unknown",
    pages: meta.pages,
    chars: meta.chars
  };
  if (mode === "spilled") value.tokens_est = estimateTokens(meta.chars);
  if (meta.stats !== void 0) value.stats = meta.stats;
  if (meta.issues !== void 0 && meta.issues.length > 0) value.issues = meta.issues;
  if (value.verdict === "suspect") value.suggest = `pdf_read(handle='${meta.handle}', page=${Math.min(meta.pages, 1)})`;
  if (mode === "inline") value.content = body;
  return value;
}
function createExtractTool(deps) {
  return {
    name: "pdf_extract",
    description: "\u8BFB\u53D6 PDF \u5E76\u8FD4\u56DE\u6B63\u6587\u4E0E\u8D28\u91CF\u5224\u5B9A\u3002\u8F6C\u6362\u540E \u2264 inlineLimit\uFF08\u9ED8\u8BA4 6000 \u5B57\u7B26\uFF09\u7684\u6587\u4EF6\u76F4\u63A5\u8FD4\u56DE\u5168\u6587\uFF1B\u66F4\u5927\u7684\u6587\u4EF6\u53EA\u8FD4\u56DE\u6458\u8981\u4E0E handle\uFF0C\u6B63\u6587\u7528 pdf_read \u6309\u9875\u8BFB\u53D6\u3002",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "PDF \u7EDD\u5BF9\u8DEF\u5F84\u6216\u5DE5\u4F5C\u533A\u76F8\u5BF9\u8DEF\u5F84" },
        pages: { type: "string", description: "\u9875\u8303\u56F4\uFF0C\u5982 1-10\uFF1B\u7701\u7565\u4E3A\u5168\u90E8\u3002\u9875\u7801\u662F\u539F\u6587\u9875\u7801" },
        inlineLimit: { type: "number", description: "\u5165\u4E0A\u4E0B\u6587\u5B57\u7B26\u4E0A\u9650\uFF0C\u9ED8\u8BA4\u7528\u914D\u7F6E\u503C\uFF086000\uFF09\uFF0C0 \u8868\u793A\u603B\u662F\u843D\u76D8" },
        force: { type: "boolean", description: "\u5FFD\u7565\u7F13\u5B58\u91CD\u65B0\u8F6C\u6362", default: false }
      },
      required: ["path"]
    },
    output: {
      schema,
      render(_args, raw) {
        const value = raw;
        const head = [
          `pdf ${value.verdict}`,
          `${value.pages}\u9875`,
          `${value.chars}\u5B57\u7B26`,
          value.tokens_est === void 0 ? null : `~${value.tokens_est} tokens`,
          value.stats === void 0 ? null : `${value.stats.tables ?? 0}\u8868\u683C`,
          value.stats === void 0 ? null : `${value.stats.headings ?? 0}\u6807\u9898`,
          `engine=${value.engine}${value.degraded ? "(\u964D\u7EA7)" : ""}`
        ].filter((part) => part !== null).join(" \xB7 ");
        const lines = [head, `handle=${value.handle}`];
        for (const issue of value.issues ?? []) lines.push(`- ${issue}`);
        if (value.suggest !== void 0) lines.push(`\u4E0B\u4E00\u6B65\uFF1A${value.suggest}`);
        if (value.content !== void 0) lines.push("", value.content);
        else lines.push("\u6B63\u6587\u672A\u8FDB\u4E0A\u4E0B\u6587\uFF1A\u7528 pdf_read \u6309\u9875\u8BFB\u53D6");
        return [{ type: "text", text: lines.join("\n") }];
      }
    },
    async execute(rawArgs, exec) {
      const args = rawArgs;
      if (typeof args.path !== "string" || args.path.trim() === "") throw new Error("path \u5FC5\u586B");
      const absPath = resolveInputPath(args.path);
      const info = await stat2(absPath).catch(() => null);
      if (info === null || !info.isFile()) throw new Error(`\u6587\u4EF6\u4E0D\u5B58\u5728\u6216\u4E0D\u662F\u666E\u901A\u6587\u4EF6\uFF1A${absPath}`);
      const params = {
        ...PARAMS_BASE,
        ...typeof args.pages === "string" && args.pages.trim() !== "" ? { pages: args.pages.trim() } : {}
      };
      const inlineLimit = typeof args.inlineLimit === "number" && Number.isFinite(args.inlineLimit) && args.inlineLimit >= 0 ? args.inlineLimit : deps.config.inlineLimit;
      const cacheDir = expandHome(deps.config.cacheDir);
      const fileSha256 = await sha256File(absPath);
      if (args.force !== true) {
        const hit = await lookupFile(cacheDir, fileSha256, params);
        if (hit !== null) return toValue(hit.meta, hit.body, inlineLimit);
      }
      const engine = await deps.registry.select(exec.signal);
      const converted = await engine.convert({ absPath, ...params.pages === void 0 ? {} : { pages: params.pages }, signal: exec.signal });
      const metrics = computeMetrics(converted.markdown);
      const handle = cacheKey(fileSha256, converted.engine, converted.engineVersion, params);
      const meta = {
        handle,
        engine: converted.engine,
        engineVersion: converted.engineVersion,
        degraded: converted.degraded,
        params,
        pages: metrics.pages,
        chars: metrics.chars,
        cachedAt: (/* @__PURE__ */ new Date()).toISOString(),
        fileSha256,
        sourcePath: absPath,
        sourceSize: info.size,
        sourceMtimeMs: info.mtimeMs,
        stats: {
          replacement_ratio: round(metrics.replacement_ratio),
          control_ratio: round(metrics.control_ratio),
          private_use_ratio: round(metrics.private_use_ratio),
          cjk_ratio: round(metrics.cjk_ratio),
          question_run_max: metrics.question_run_max,
          avg_chars_per_line: round(metrics.avg_chars_per_line),
          single_char_line_ratio: round(metrics.single_char_line_ratio),
          line_end_punct_ratio: round(metrics.line_end_punct_ratio),
          page_char_variance: round(metrics.page_char_variance),
          empty_pages: metrics.empty_pages,
          last_page_ratio: round(metrics.last_page_ratio),
          tables: metrics.tables,
          headings: metrics.headings
        },
        verdict: deps.config.judgeEnabled ? "ok" : "unknown"
      };
      await writeEntry(cacheDir, { handle, body: converted.markdown, meta });
      return toValue(meta, converted.markdown, inlineLimit);
    }
  };
}
function round(value) {
  return Math.round(value * 1e4) / 1e4;
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
  ctx.tools.register(createExtractTool({ ctx, registry, config: cfg }));
  const logger = typeof ctx.logger === "function" ? ctx.logger("pdf-reader") : void 0;
  logger?.info(`\u5DE5\u5177\u5C42\u5DF2\u88C5\u8F7D\uFF08inlineLimit=${cfg.inlineLimit}, judgeEnabled=${cfg.judgeEnabled}\uFF09`);
}
export {
  CONFIG_DEFAULTS,
  ENGINE_PRIORITY,
  EngineError,
  apply,
  cacheKey,
  computeMetrics,
  createEngineRegistry,
  createExtractTool,
  createPingTool,
  detectJava,
  estimateTokens,
  expandHome,
  inject,
  lookupFile,
  name,
  paramsSignature,
  parseJavaVersion,
  readEntry,
  recentHandles,
  resolveConfig,
  runProcess,
  sha256File,
  splitPages,
  writeEntry
};
