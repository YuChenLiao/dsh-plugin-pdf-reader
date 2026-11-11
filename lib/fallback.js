// src/engines/fallback.ts
import { readFile } from "node:fs/promises";
import { createRequire as createRequire2 } from "node:module";

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

// src/upstream.ts
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { buildArgs } from "@opendataloader/pdf";
var PAGE_SEPARATOR = "<!-- PAGE %page-number% -->";
function pageMarker(page) {
  return PAGE_SEPARATOR.replace("%page-number%", String(page));
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
      const data = await readFile(request.absPath).catch((error) => {
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
function apply(ctx, config) {
  const cfg = resolveFallbackConfig(config);
  attachEngine(ctx, () => createFallbackEngine(cfg));
}
export {
  PAGE_SEPARATOR,
  apply,
  createFallbackEngine,
  name,
  pageMarker,
  parsePageRange,
  resolveFallbackConfig,
  resolvePdfiumVersion
};
