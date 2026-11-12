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
function createEngineRegistry(availabilityRetryMs = 6e4) {
  const engines = /* @__PURE__ */ new Map();
  const cache = /* @__PURE__ */ new Map();
  const inflight = /* @__PURE__ */ new Map();
  const check = (engine, signal) => {
    const cached = cache.get(engine.name);
    if (cached !== void 0 && (cached.value.ok || Date.now() - cached.at < availabilityRetryMs)) {
      return Promise.resolve(cached.value);
    }
    const running = inflight.get(engine.name);
    if (running !== void 0) return running;
    const pending = engine.available(signal).then((result) => {
      cache.set(engine.name, { value: result, at: Date.now() });
      return result;
    }).catch((error) => {
      const result = { ok: false, reason: error instanceof Error ? error.message : String(error) };
      cache.set(engine.name, { value: result, at: Date.now() });
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
        if (engine.explicitOnly === true) continue;
        const availability = await check(engine, signal);
        if (availability.ok) return engine;
        reasons.push(`${engine.name}: ${availability.reason ?? "\u4E0D\u53EF\u7528"}`);
      }
      throw new EngineError("unavailable", reasons.length === 0 ? "\u81EA\u52A8\u94FE\u91CC\u6CA1\u6709\u53EF\u7528\u5F15\u64CE" : `\u81EA\u52A8\u94FE\u91CC\u6CA1\u6709\u53EF\u7528\u5F15\u64CE\uFF08${reasons.join("\uFF1B")}\uFF09`);
    },
    async selectNamed(name2, signal) {
      const engine = engines.get(name2);
      if (engine === void 0) throw new EngineError("unavailable", `\u5F15\u64CE "${name2}" \u6CA1\u6709\u6CE8\u518C\uFF08\u5BF9\u5E94\u7EC4\u4EF6\u672A\u88C5\u8F7D\uFF09`);
      const availability = await check(engine, signal);
      if (!availability.ok) throw new EngineError("unavailable", `\u5F15\u64CE "${name2}" \u4E0D\u53EF\u7528\uFF1A${availability.reason ?? "\u672A\u77E5\u539F\u56E0"}`);
      return engine;
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
          explicitOnly: engine.explicitOnly === true,
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
  const schema3 = {
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
            explicitOnly: { type: "boolean" },
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
      schema: schema3,
      render(_args, raw) {
        const value = raw;
        const java = value.java.ok ? `java=${value.java.version ?? "?"} (${value.java.binary})` : `java=\u4E0D\u53EF\u7528\uFF08${value.java.reason ?? "\u672A\u77E5\u539F\u56E0"}\uFF09`;
        const engines = value.engines.map((engine) => `${engine.name}${engine.explicitOnly === true ? "(\u6309\u9700)" : ""}:${engine.ok ? "ok" : `\u5173\u95ED\uFF08${engine.reason ?? "\u4E0D\u53EF\u7528"}\uFF09`}`).join(" \xB7 ");
        return [{ type: "text", text: `pong \xB7 ${java}
\u5F15\u64CE: ${engines || "(\u65E0)"}` }];
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
          ...engine.explicitOnly ? { explicitOnly: true } : {},
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
async function lookupFile(cacheDir, fileSha256, params, engine) {
  const index = await readJson(fileIndexPath(cacheDir, fileSha256));
  if (index === null) return null;
  const signature = paramsSignature(params);
  const matches = index.entries.filter((entry) => paramsSignature(entry.params) === signature && (engine === void 0 || entry.engine === engine));
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
var PAGE_MARK = /<!--\s*PAGE\s+(\d+)\s*-->/g;
function splitPagesWithNumbers(markdown) {
  const marks = [];
  PAGE_MARK.lastIndex = 0;
  for (let match = PAGE_MARK.exec(markdown); match !== null; match = PAGE_MARK.exec(markdown)) {
    marks.push({ page: Number.parseInt(match[1], 10), start: match.index, end: match.index + match[0].length });
  }
  if (marks.length === 0) return [{ page: 1, text: markdown }];
  const slices = [];
  for (let index = 0; index < marks.length; index += 1) {
    const mark = marks[index];
    const next = marks[index + 1];
    slices.push({ page: mark.page, text: markdown.slice(mark.end, next === void 0 ? markdown.length : next.start) });
  }
  return slices;
}
function splitPages(markdown) {
  return splitPagesWithNumbers(markdown).map((slice) => slice.text);
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
    nonspace_chars: nonSpace.length,
    pages: pageTexts.length,
    head_cjk_ratio: ratio(countCjk(text.slice(0, 2e3).replace(/\s/g, "")), text.slice(0, 2e3).replace(/\s/g, "").length),
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
    first_empty_page: pageLengths.findIndex((length) => length < 20) + 1,
    last_page_ratio: lastPageRatio,
    tables,
    headings,
    image_only_hint: emptyPageRatio > 0.2 || pageTexts.length > 0 && chars / pageTexts.length < 100
  };
}
function estimateTokens(chars) {
  return Math.round(chars * 0.6);
}

// src/verdict.ts
var SUSPECT_WEIGHTS = {
  cjk_ratio: 25,
  empty_pages: 30,
  last_page: 15,
  avg_chars_per_line: 20,
  single_char_line: 15
};
var FAST_THRESHOLDS = {
  failed: { replacement_ratio: 5e-3, control_ratio: 0.02 },
  suspect: {
    head_cjk_min: 0.05,
    cjk_ratio_min: 0.25,
    avg_chars_per_line_min: 5,
    single_char_line_ratio_max: 0.3,
    empty_page_ratio_max: 0.2,
    last_page_ratio_min: 0.05,
    last_page_min_chars_per_page: 100
  }
};
var HYBRID_THRESHOLDS = FAST_THRESHOLDS;
var FALLBACK_THRESHOLDS = FAST_THRESHOLDS;
function thresholdsOf(engine) {
  if (engine === "hybrid") return HYBRID_THRESHOLDS;
  if (engine === "fallback") return FALLBACK_THRESHOLDS;
  return FAST_THRESHOLDS;
}
var pct = (value) => (value * 100).toFixed(2).replace(/\.?0+$/, "");
function judge(metrics, engine, judgeEnabled = true) {
  if (!judgeEnabled) return { verdict: "unknown", score: 0, issues: [] };
  const thresholds = thresholdsOf(engine);
  const issues = [];
  if (metrics.nonspace_chars === 0) {
    return {
      verdict: "suspect",
      score: 10,
      issues: ["\u6CA1\u6709\u4EFB\u4F55\u6587\u672C\uFF08\u53EA\u6709\u7A7A\u767D\uFF09\uFF1A\u7591\u4F3C\u626B\u63CF\u4EF6\u6216\u56FE\u7247\u7248\u6587\u6863\uFF0C\u5F53\u524D\u5F15\u64CE\u6CA1\u6709\u6587\u672C\u5C42"]
    };
  }
  if (metrics.replacement_ratio > thresholds.failed.replacement_ratio) {
    return {
      verdict: "failed",
      score: 0,
      issues: [`replacement_ratio ${pct(metrics.replacement_ratio)}\uFF1A\u63D0\u53D6\u51FA\u5927\u91CF\u66FF\u6362\u5B57\u7B26 U+FFFD\uFF0C\u7F16\u7801\u5DF2\u635F\u574F`]
    };
  }
  if (metrics.control_ratio > thresholds.failed.control_ratio) {
    return {
      verdict: "failed",
      score: 0,
      issues: [`control_ratio ${pct(metrics.control_ratio)}\uFF1A\u63A7\u5236\u5B57\u7B26\u5360\u6BD4\u8FC7\u9AD8\uFF0C\u5185\u5BB9\u4E0D\u53EF\u7528`]
    };
  }
  if (engine === "fallback") return { verdict: "ok", score: 60, issues: [] };
  let score = 100;
  const suspect = thresholds.suspect;
  if (metrics.head_cjk_ratio >= suspect.head_cjk_min && metrics.cjk_ratio < suspect.cjk_ratio_min) {
    score -= SUSPECT_WEIGHTS.cjk_ratio;
    issues.push(`cjk_ratio ${pct(metrics.cjk_ratio)}\uFF1A\u9996\u90E8\u662F\u4E2D\u6587\uFF08${pct(metrics.head_cjk_ratio)}\uFF09\u4F46\u5168\u6587\u4E2D\u6587\u5360\u6BD4\u8FC7\u4F4E\uFF0C\u7591\u4F3C\u7F16\u7801\u9519`);
  }
  if (metrics.avg_chars_per_line < suspect.avg_chars_per_line_min) {
    score -= SUSPECT_WEIGHTS.avg_chars_per_line;
    issues.push(`avg_chars_per_line ${metrics.avg_chars_per_line.toFixed(1)}\uFF1A\u5E73\u5747\u884C\u957F\u8FC7\u77ED\uFF0C\u7591\u4F3C\u7248\u9762\u88AB\u5207\u6210\u788E\u7247`);
  }
  if (metrics.single_char_line_ratio > suspect.single_char_line_ratio_max) {
    score -= SUSPECT_WEIGHTS.single_char_line;
    issues.push(`single_char_line_ratio ${pct(metrics.single_char_line_ratio)}\uFF1A\u5355\u5B57\u7B26\u884C\u8FC7\u591A\uFF0C\u7591\u4F3C\u9010\u5B57\u65AD\u884C`);
  }
  if (metrics.empty_page_ratio > suspect.empty_page_ratio_max) {
    score -= SUSPECT_WEIGHTS.empty_pages;
    issues.push(`empty_pages ${metrics.empty_pages}/${metrics.pages}\uFF1A\u7591\u4F3C\u626B\u63CF\u4EF6\uFF0C\u5F53\u524D\u5F15\u64CE\u6CA1\u6709\u6587\u672C\u5C42`);
  }
  const charsPerPage = metrics.pages === 0 ? 0 : metrics.chars / metrics.pages;
  if (charsPerPage >= suspect.last_page_min_chars_per_page && metrics.last_page_ratio < suspect.last_page_ratio_min) {
    score -= SUSPECT_WEIGHTS.last_page;
    issues.push(`last_page_ratio ${pct(metrics.last_page_ratio)}\uFF1A\u672B\u9875\u51E0\u4E4E\u4E3A\u7A7A\uFF0C\u7591\u4F3C\u622A\u65AD`);
  }
  if (issues.length > 0) return { verdict: "suspect", score: Math.max(0, score), issues };
  return { verdict: "ok", score: 100, issues: [] };
}

// src/upstream.ts
import { existsSync } from "node:fs";
import { dirname, join as join2 } from "node:path";
import { createRequire } from "node:module";
import { buildArgs } from "@opendataloader/pdf";
var UPSTREAM_VERSION = "2.5.20";
var PAGE_SEPARATOR2 = "<!-- PAGE %page-number% -->";
function pageMarker(page) {
  return PAGE_SEPARATOR2.replace("%page-number%", String(page));
}
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
    const jar = join2(dirname(entry), "..", "lib", JAR_NAME);
    return existsSync(jar) ? jar : null;
  } catch {
    return null;
  }
}
function buildConvertArgv(javaBinary, jarPath, request) {
  const upstream = buildArgs({
    format: "markdown",
    markdownPageSeparator: PAGE_SEPARATOR2,
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

// src/tools/read.ts
var DEFAULT_MAX_CHARS = 2e4;
var SAFE_MAX_CHARS = 8e3;
var HANDLE_PATTERN = /^[0-9a-f]{12}$/;
var schema = {
  type: "object",
  properties: {
    handle: { type: "string" },
    from_page: { type: "number" },
    to_page: { type: "number" },
    pages: { type: "number" },
    chars: { type: "number" },
    truncated: { type: "boolean" },
    next_offset: { type: "number" },
    remaining_from: { type: "number" },
    remaining_to: { type: "number" },
    content: { type: "string" }
  },
  required: ["handle", "from_page", "to_page", "pages", "chars", "truncated", "content"]
};
function asNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : void 0;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : void 0;
  }
  return void 0;
}
function selectPages(slices, request) {
  const available = slices.map((slice) => slice.page);
  const lowest = available[0] ?? 1;
  const highest = available.at(-1) ?? 0;
  const want = (value, label) => {
    const page = Math.trunc(value);
    if (!available.includes(page)) {
      throw new Error(`${label} ${page} \u4E0D\u5728\u5DF2\u63D0\u53D6\u7684\u9875\u8303\u56F4\u5185\uFF08\u53EF\u7528 ${lowest}\u2013${highest}\uFF0C\u5171 ${slices.length} \u9875\uFF09\uFF1B\u7528 pdf_extract \u91CD\u65B0\u63D0\u53D6\u8BE5\u9875`);
    }
    return page;
  };
  let from;
  let to;
  if (request.page !== void 0) {
    from = want(request.page, "page");
    to = from;
  } else {
    from = request.pageStart === void 0 ? lowest : want(request.pageStart, "pageStart");
    to = request.pageEnd === void 0 ? highest : want(request.pageEnd, "pageEnd");
    if (to < from) [from, to] = [to, from];
  }
  const picked = slices.filter((slice) => slice.page >= from && slice.page <= to);
  return { picked, from, to, available };
}
function createReadTool(deps) {
  return {
    name: "pdf_read",
    description: "\u6309 handle \u8BFB\u53D6 pdf_extract \u5DF2\u8F6C\u6362\u6B63\u6587\u7684\u6307\u5B9A\u9875\u6216\u9875\u533A\u95F4\uFF08\u9875\u7801\u662F\u539F\u6587\u9875\u7801\uFF09\u3002\u4E0D\u91CD\u65B0\u8F6C\u6362\uFF1B\u8D85\u51FA maxChars \u65F6\u622A\u65AD\u5E76\u7ED9\u51FA\u7EED\u8BFB\u65B9\u5F0F\u3002",
    parameters: {
      type: "object",
      properties: {
        handle: { type: "string", description: "pdf_extract \u8FD4\u56DE\u7684 handle" },
        page: { type: "number", description: "\u5355\u9875\u9875\u7801\uFF08\u539F\u6587\u9875\u7801\uFF09" },
        pageStart: { type: "number", description: "\u533A\u95F4\u8D77\u59CB\u9875\uFF08\u539F\u6587\u9875\u7801\uFF09\uFF0C\u914D\u5408 pageEnd \u4F7F\u7528" },
        pageEnd: { type: "number", description: "\u533A\u95F4\u7ED3\u675F\u9875\uFF08\u542B\uFF0C\u539F\u6587\u9875\u7801\uFF09" },
        maxChars: { type: "number", description: "\u8FD4\u56DE\u5B57\u7B26\u4E0A\u9650\uFF0C\u9ED8\u8BA4 8000\uFF08\u518D\u9AD8\u4F1A\u88AB dsh \u7684 pruner \u88C1\u526A\uFF09" },
        offset: { type: "number", description: "\u4ECE\u6240\u9009\u8303\u56F4\u7684\u7B2C\u51E0\u4E2A\u5B57\u7B26\u5F00\u59CB\u8FD4\u56DE\uFF0C\u9ED8\u8BA4 0\uFF1B\u5355\u9875\u622A\u65AD\u540E\u7528 next_offset \u7EED\u8BFB" }
      },
      required: ["handle"]
    },
    output: {
      schema,
      render(_args, raw) {
        const value = raw;
        const range = value.from_page === value.to_page ? `\u7B2C ${value.from_page} \u9875` : `\u7B2C ${value.from_page}\u2013${value.to_page} \u9875`;
        const head = `${value.handle} \xB7 ${range}\uFF08\u5171 ${value.pages} \u9875\uFF0C${value.chars} \u5B57\u7B26\uFF09`;
        let tail = "";
        if (value.truncated) {
          tail = value.next_offset !== void 0 ? `
[\u5DF2\u622A\u65AD\uFF1A\u672C\u9875\u8FD8\u6709\u5185\u5BB9\uFF0C\u7528 offset=${value.next_offset} \u7EED\u8BFB]` : `
[\u5DF2\u622A\u65AD\uFF1A\u53EA\u8FD4\u56DE\u4E86\u533A\u95F4\u5F00\u5934\uFF0C\u7528 offset=${value.chars} \u7EED\u8BFB\u540C\u4E00\u533A\u95F4]`;
        }
        return [{ type: "text", text: `${head}

${value.content}${tail}` }];
      }
    },
    async execute(rawArgs) {
      const args = rawArgs;
      const handle = typeof args.handle === "string" ? args.handle.trim() : "";
      if (handle === "") throw new Error("handle \u5FC5\u586B");
      if (!HANDLE_PATTERN.test(handle)) throw new Error(`handle "${handle}" \u683C\u5F0F\u4E0D\u5BF9\uFF1A\u5E94\u4E3A 12 \u4F4D\u5341\u516D\u8FDB\u5236\uFF08pdf_extract \u8FD4\u56DE\u7684\u503C\uFF09`);
      const cacheDir = expandHome(deps.config.cacheDir);
      const entry = await readEntry(cacheDir, handle);
      if (entry === null) {
        const recent = await recentHandles(cacheDir, 5);
        const hint = recent.length > 0 ? `\u6700\u8FD1\u53EF\u7528\u7684 handle\uFF1A${recent.join(", ")}` : "\u7F13\u5B58\u76EE\u5F55\u91CC\u8FD8\u6CA1\u6709\u4EFB\u4F55\u8F6C\u6362\u7ED3\u679C\uFF0C\u5148\u8C03\u7528 pdf_extract";
        throw new Error(`handle "${handle}" \u4E0D\u5B58\u5728\u3002${hint}`);
      }
      const slices = splitPagesWithNumbers(entry.body);
      const known = entry.meta.pageNumbers;
      const numbered = known !== void 0 && known.length === slices.length ? slices.map((slice2, index) => ({ page: known[index], text: slice2.text })) : slices;
      const requestedMax = asNumber(args.maxChars);
      const maxChars = requestedMax !== void 0 && requestedMax > 0 ? Math.trunc(requestedMax) : Math.min(deps.config.inlineLimit > 0 ? deps.config.inlineLimit : DEFAULT_MAX_CHARS, SAFE_MAX_CHARS);
      const selection = selectPages(numbered, {
        ...asNumber(args.page) === void 0 ? {} : { page: asNumber(args.page) },
        ...asNumber(args.pageStart) === void 0 ? {} : { pageStart: asNumber(args.pageStart) },
        ...asNumber(args.pageEnd) === void 0 ? {} : { pageEnd: asNumber(args.pageEnd) }
      });
      const joined = selection.picked.map((slice2) => `<!-- PAGE ${slice2.page} -->
${slice2.text.trim()}`).join("\n");
      const offset = Math.max(0, Math.trunc(asNumber(args.offset) ?? 0));
      const slice = joined.slice(offset, offset + maxChars);
      const truncated = offset + slice.length < joined.length;
      const value = {
        handle,
        from_page: selection.from,
        to_page: selection.to,
        pages: numbered.length,
        chars: slice.length,
        truncated,
        content: slice
      };
      if (truncated) {
        value.next_offset = offset + slice.length;
      }
      return value;
    }
  };
}

// src/tools/extract.ts
var PARAMS_BASE = { separator: PAGE_SEPARATOR2 };
var INLINE_HARD_CEILING = 8192;
var schema2 = {
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
function spillOrInline(bodyChars, inlineLimit) {
  if (inlineLimit === 0) return "spilled";
  return bodyChars <= inlineLimit ? "inline" : "spilled";
}
function toValue(meta, body, inlineLimit, hybridUsable = false) {
  const mode = spillOrInline(meta.bodyChars ?? meta.chars, inlineLimit);
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
  if (value.verdict === "suspect") {
    const noText = (meta.stats?.nonspace_chars ?? 0) === 0;
    if (noText && hybridUsable === true) {
      value.suggest = `pdf_extract(path='${meta.sourcePath}', engine='hybrid')  # \u626B\u63CF\u4EF6\uFF1Ahybrid + OCR \u7EA6 25s/\u9875`;
    } else if (!noText) {
      const page = (meta.stats?.first_empty_page ?? 0) > 0 ? meta.stats.first_empty_page : 1;
      value.suggest = `pdf_read(handle='${meta.handle}', page=${page})`;
    }
  }
  if (mode === "inline" && (meta.stats?.nonspace_chars ?? 1) > 0) value.content = body;
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
        engine: {
          type: "string",
          enum: ["auto", "fast", "fallback", "hybrid"],
          description: "\u6307\u5B9A\u5F15\u64CE\u3002auto\uFF08\u9ED8\u8BA4\uFF09\u6309 fast \u2192 fallback \u987A\u5E8F\u81EA\u52A8\u9009\uFF1Bhybrid \u6162\uFF088\u201310s/\u9875\uFF0C\u626B\u63CF\u4EF6 + OCR \u7EA6 25s/\u9875\uFF09\u4F46\u80FD\u8BFB\u590D\u6742\u8868\u683C\u4E0E\u626B\u63CF\u4EF6\uFF0C\u9700\u663E\u5F0F\u6307\u5B9A"
        },
        inlineLimit: { type: "number", description: "\u5165\u4E0A\u4E0B\u6587\u5B57\u7B26\u4E0A\u9650\uFF0C\u9ED8\u8BA4\u7528\u914D\u7F6E\u503C\uFF086000\uFF09\uFF0C0 \u8868\u793A\u603B\u662F\u843D\u76D8" },
        force: { type: "boolean", description: "\u5FFD\u7565\u7F13\u5B58\u91CD\u65B0\u8F6C\u6362", default: false }
      },
      required: ["path"]
    },
    output: {
      schema: schema2,
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
        else if (value.verdict === "suspect" || value.verdict === "failed") lines.push("\u672C\u5F15\u64CE\u6CA1\u6709\u63D0\u53D6\u5230\u6587\u672C\uFF0Cpdf_read \u4E5F\u8BFB\u4E0D\u5230\u5185\u5BB9");
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
      const requestedInline = asNumber(args.inlineLimit);
      if (requestedInline !== void 0 && requestedInline > INLINE_HARD_CEILING) {
        throw new Error(`inlineLimit \u4E0A\u9650\u662F ${INLINE_HARD_CEILING} \u5B57\u7B26\uFF1A\u8D85\u8FC7\u5B83\u4F1A\u88AB dsh \u7684 tool-result-pruner \u622A\u6210"\u5934+\u5C3E"\u5E76\u4E22\u6B63\u6587`);
      }
      const inlineLimit = requestedInline !== void 0 && requestedInline >= 0 ? requestedInline : deps.config.inlineLimit;
      const cacheDir = expandHome(deps.config.cacheDir);
      const requested = typeof args.engine === "string" ? args.engine.trim() : "auto";
      const explicitEngine = requested === "" || requested === "auto" ? void 0 : requested;
      const hybridUsable = async () => {
        const probes = await deps.registry.probe(exec.signal);
        return probes.some((probe) => probe.name === "hybrid" && probe.ok);
      };
      const fileSha256 = await sha256File(absPath);
      if (args.force !== true) {
        const hit = await lookupFile(cacheDir, fileSha256, params, explicitEngine);
        if (hit !== null) return toValue(hit.meta, hit.body, inlineLimit, hit.meta.verdict === "suspect" ? await hybridUsable() : false);
      }
      const engine = explicitEngine === void 0 ? await deps.registry.select(exec.signal) : await deps.registry.selectNamed(explicitEngine, exec.signal);
      const converted = await engine.convert({ absPath, ...params.pages === void 0 ? {} : { pages: params.pages }, signal: exec.signal });
      const metrics = computeMetrics(converted.markdown);
      const judgment = judge(metrics, converted.engine, deps.config.judgeEnabled);
      const pageNumbers = splitPagesWithNumbers(converted.markdown).map((slice) => slice.page);
      const handle = cacheKey(fileSha256, converted.engine, converted.engineVersion, params);
      const meta = {
        handle,
        engine: converted.engine,
        engineVersion: converted.engineVersion,
        degraded: converted.degraded,
        params,
        pages: metrics.pages,
        chars: metrics.chars,
        pageNumbers,
        bodyChars: converted.markdown.length,
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
          empty_page_ratio: round(metrics.empty_page_ratio),
          head_cjk_ratio: round(metrics.head_cjk_ratio),
          nonspace_chars: metrics.nonspace_chars,
          first_empty_page: metrics.first_empty_page,
          last_page_ratio: round(metrics.last_page_ratio),
          tables: metrics.tables,
          headings: metrics.headings
        },
        verdict: judgment.verdict,
        ...judgment.issues.length > 0 ? { issues: judgment.issues } : {},
        ...judgment.verdict === "suspect" ? { score: judgment.score } : {}
      };
      await writeEntry(cacheDir, { handle, body: converted.markdown, meta });
      const usable = meta.verdict === "suspect" ? await hybridUsable() : false;
      return toValue(meta, converted.markdown, inlineLimit, usable);
    }
  };
}
function round(value) {
  return Math.round(value * 1e4) / 1e4;
}

// src/engines/fallback.ts
import { readFile as readFile2 } from "node:fs/promises";
import { createRequire as createRequire2 } from "node:module";
function resolvePdfiumVersion() {
  try {
    const require2 = createRequire2(import.meta.url);
    const pkg = require2("@hyzyla/pdfium/package.json");
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return null;
  }
}
function resolveFallbackConfig(raw) {
  const input = raw !== null && typeof raw === "object" ? raw : {};
  const timeoutMs = typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs) && input.timeoutMs > 0 ? input.timeoutMs : 6e4;
  return { enabled: input.enabled !== false, timeoutMs };
}
var cachedLibrary = null;
async function defaultLibrary() {
  cachedLibrary ??= (async () => {
    const module = await import("@hyzyla/pdfium");
    const lib = await module.PDFiumLibrary.init();
    return lib;
  })();
  try {
    return await cachedLibrary;
  } catch (error) {
    cachedLibrary = null;
    throw error;
  }
}
function createFallbackEngine(cfg, deps = {}) {
  const versionOf = deps.versionOf ?? resolvePdfiumVersion;
  const libOf = deps.libOf ?? defaultLibrary;
  return {
    name: "fallback",
    priority: ENGINE_PRIORITY.fallback,
    get version() {
      return versionOf() ?? "unknown";
    },
    async available() {
      if (!cfg.enabled) return { ok: false, reason: "\u7EC4\u4EF6\u5DF2\u5173\u95ED\uFF08enabled: false\uFF09" };
      if (versionOf() === null) return { ok: false, reason: "\u672A\u5B89\u88C5 @hyzyla/pdfium" };
      return { ok: true };
    },
    async convert(request) {
      if (!cfg.enabled) throw new EngineError("unavailable", "\u7EC4\u4EF6\u5DF2\u5173\u95ED\uFF08enabled: false\uFF09");
      const version = versionOf();
      if (version === null) throw new EngineError("unavailable", "\u672A\u5B89\u88C5 @hyzyla/pdfium");
      const deadline = AbortSignal.timeout(cfg.timeoutMs);
      const data = await readFile2(request.absPath).catch((error) => {
        throw new EngineError("missing-file", `\u8BFB\u53D6\u5931\u8D25\uFF1A${error instanceof Error ? error.message : String(error)}`);
      });
      let library;
      try {
        library = await libOf();
      } catch (error) {
        throw new EngineError("engine-error", `pdfium \u521D\u59CB\u5316\u5931\u8D25\uFF1A${error instanceof Error ? error.message : String(error)}`);
      }
      let document;
      try {
        document = await library.loadDocument(data);
      } catch (error) {
        throw new EngineError("not-pdf", `\u65E0\u6CD5\u89E3\u6790\u4E3A PDF\uFF1A${error instanceof Error ? error.message : String(error)}`);
      }
      try {
        const total = document.getPageCount();
        if (total === 0) throw new EngineError("engine-error", "PDF \u91CC\u6CA1\u6709\u4EFB\u4F55\u9875\u9762");
        const wanted = request.pages === void 0 ? null : parsePageRange(request.pages, total);
        const blocks = [];
        for (let page = 1; page <= total; page += 1) {
          if (request.signal.aborted) throw new EngineError("aborted", "\u8F6C\u6362\u88AB\u53D6\u6D88");
          if (deadline.aborted) throw new EngineError("timeout", `fallback \u5F15\u64CE\u8F6C\u6362\u8D85\u65F6\uFF08${cfg.timeoutMs}ms\uFF09`);
          if (wanted !== null && !wanted.has(page)) continue;
          const text = await document.getPage(page - 1).getText();
          blocks.push(`${pageMarker(page)}
${text.trim()}`);
        }
        if (blocks.length === 0) throw new EngineError("engine-error", `\u9875\u8303\u56F4 "${request.pages ?? ""}" \u6CA1\u6709\u547D\u4E2D\u4EFB\u4F55\u9875`);
        return { markdown: blocks.join("\n"), engine: "fallback", engineVersion: version, degraded: true };
      } finally {
        document.destroy();
      }
    }
  };
}

// src/engines/hybrid.ts
import { connect } from "node:net";
import { readFile as readFile3, writeFile as writeFile2, mkdir as mkdir2 } from "node:fs/promises";
import { dirname as pathDirname, isAbsolute as isAbsolute2, join as join3, resolve as resolvePath3 } from "node:path";
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
      const input = isAbsolute2(request.absPath) ? request.absPath : resolvePath3(request.absPath);
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
      if (result.stdout.trim() === "") throw new EngineError("engine-error", "\u8F6C\u6362\u6210\u529F\u4F46\u6CA1\u6709\u4EFB\u4F55\u8F93\u51FA\uFF08\u7591\u4F3C\u626B\u63CF\u4EF6\u6216\u7A7A\u6587\u6863\uFF09");
      return { markdown: result.stdout, engine: "hybrid", engineVersion: UPSTREAM_VERSION, degraded: false };
    },
    /** 供工具层 dispose 时收尾：停掉自己拉起的后端。 */
    dispose() {
      backend?.stop();
      backend = null;
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
    return JSON.parse(await readFile3(file, "utf8"));
  } catch {
    return null;
  }
}

// src/plugin.ts
var name = "dsh-plugin-pdf-reader";
var inject = ["tools"];
var CONFIG_DEFAULTS = {
  enabled: true,
  inlineLimit: 6e3,
  cacheDir: "~/.dsh/pdf-cache",
  judgeEnabled: true,
  javaBinary: "java"
};
var ConfigError2 = class extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
  }
};
function asBoolean(value, key, fallback) {
  if (value === void 0) return fallback;
  if (typeof value !== "boolean") throw new ConfigError2(`config.${key} \u5FC5\u987B\u662F\u5E03\u5C14\u503C`);
  return value;
}
function asString(value, key, fallback) {
  if (value === void 0) return fallback;
  if (typeof value !== "string" || value.trim() === "") throw new ConfigError2(`config.${key} \u5FC5\u987B\u662F\u975E\u7A7A\u5B57\u7B26\u4E32`);
  return value;
}
function resolveConfig(raw) {
  if (raw === void 0 || raw === null) return { ...CONFIG_DEFAULTS };
  if (typeof raw !== "object" || Array.isArray(raw)) throw new ConfigError2("config \u5FC5\u987B\u662F\u5BF9\u8C61");
  const input = raw;
  const inlineLimit = input.inlineLimit;
  if (inlineLimit !== void 0) {
    if (typeof inlineLimit !== "number" || !Number.isFinite(inlineLimit) || inlineLimit < 0) {
      throw new ConfigError2("config.inlineLimit \u5FC5\u987B\u662F\u975E\u8D1F\u6570\u5B57");
    }
    if (inlineLimit > INLINE_HARD_CEILING) {
      throw new ConfigError2(`config.inlineLimit \u4E0A\u9650\u662F ${INLINE_HARD_CEILING} \u5B57\u7B26\uFF1A\u8D85\u8FC7\u5B83\u4F1A\u88AB dsh \u7684 tool-result-pruner \u622A\u6210"\u5934+\u5C3E"\u5E76\u9759\u9ED8\u4E22\u6B63\u6587`);
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
  ctx.tools.register(createReadTool({ config: cfg }));
  const logger = typeof ctx.logger === "function" ? ctx.logger("pdf-reader") : void 0;
  logger?.info(`\u5DE5\u5177\u5C42\u5DF2\u88C5\u8F7D\uFF08inlineLimit=${cfg.inlineLimit}, judgeEnabled=${cfg.judgeEnabled}\uFF09`);
}
export {
  CONFIG_DEFAULTS,
  ENGINE_PRIORITY,
  EngineError,
  FALLBACK_THRESHOLDS,
  FAST_THRESHOLDS,
  HYBRID_THRESHOLDS,
  SUSPECT_WEIGHTS,
  apply,
  backendArgv,
  backendUrlOf,
  cacheKey,
  computeMetrics,
  createEngineRegistry,
  createExtractTool,
  createFallbackEngine,
  createHybridEngine,
  createPingTool,
  createReadTool,
  detectJava,
  estimateTokens,
  expandHome,
  inject,
  judge,
  lookupFile,
  name,
  pageMarker,
  paramsSignature,
  parseJavaVersion,
  parsePageRange,
  probePort,
  readEntry,
  readHybridState,
  recentHandles,
  resolveConfig,
  resolveFallbackConfig,
  resolveHybridConfig,
  resolvePdfiumVersion,
  runProcess,
  sha256File,
  splitPages,
  thresholdsOf,
  writeEntry
};
