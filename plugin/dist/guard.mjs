// core/guard.ts
import { readFileSync, realpathSync } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { dirname, isAbsolute, join as join2, resolve, sep } from "node:path";

// core/paths.ts
import { homedir } from "node:os";
import { join } from "node:path";
function meshworkHome(env = process.env, home = homedir()) {
  return env.MESHWORK_HOME || join(home, ".claude", "channels", "meshwork");
}

// core/guard.ts
var REASON_ASSET = "Meshwork \uBCF4\uD638 \u2014 \uB85C\uADF8\uC778 \uD1A0\uD070 \xB7 \uC124\uC815 \uD3F4\uB354(~/.claude/channels/meshwork)\uB294 \uC77D\uAC70\uB098 \uBC14\uAFC0 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4. \uB85C\uADF8\uC778 \xB7 \uC124\uC815\uC740 /meshwork:login \xB7 /meshwork:status \uAC19\uC740 \uBA85\uB839\uC73C\uB85C \uD558\uC138\uC694.";
var REASON_PLUGIN = "Meshwork \uBCF4\uD638 \u2014 Meshwork \uD50C\uB7EC\uADF8\uC778 \uC124\uCE58\uBCF8\uC740 \uACE0\uCE60 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4. \uC5C5\uB370\uC774\uD2B8\uB294 /plugin \uC5D0\uC11C \uD558\uC138\uC694.";
var REASON_HOOKS = "Meshwork \uBCF4\uD638 \u2014 \uD6C5\uC744 \uB044\uAC70\uB098 Meshwork \uD50C\uB7EC\uADF8\uC778\uC744 \uB044\uB294 \uC124\uC815\uC740 \uBC14\uAFC0 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4. \uD544\uC694\uD558\uBA74 \uC0AC\uC6A9\uC790\uAC00 \uC9C1\uC811 \uBC14\uAFB8\uC138\uC694.";
var FILE_TOOLS = {
  Read: { field: "file_path", write: false },
  Write: { field: "file_path", write: true },
  Edit: { field: "file_path", write: true },
  MultiEdit: { field: "file_path", write: true },
  NotebookRead: { field: "notebook_path", write: false },
  NotebookEdit: { field: "notebook_path", write: true },
  LS: { field: "path", write: false }
};
var SEARCH_TOOLS = /* @__PURE__ */ new Set(["Grep", "Glob"]);
var OWN_MCP = /^mcp__plugin_meshwork_meshwork__/;
var BULK = /* @__PURE__ */ new Set([
  "mv",
  "cp",
  "ln",
  "tar",
  "rsync",
  "zip",
  "ditto",
  "scp",
  "cpio",
  "find",
  "chmod",
  "chown",
  "rm"
]);
var str = (v) => typeof v === "string" ? v : void 0;
function guard(input, o) {
  const tool = str(input.tool_name);
  const args = input.tool_input;
  if (!tool || !args || typeof args !== "object") return null;
  if (OWN_MCP.test(tool)) return null;
  const a = args;
  const platform = o.platform ?? process.platform;
  const fold = platform === "darwin" || platform === "win32";
  const home = o.home ?? homedir2();
  const cwd = str(input.cwd) ?? process.cwd();
  const norm = (p) => {
    const x = resolve(p).replace(/[\\/]+$/, "") || sep;
    return fold ? x.toLowerCase() : x;
  };
  const real = (p) => {
    let cur = resolve(p);
    const rest = [];
    for (; ; ) {
      try {
        return norm(join2(realpathSync(cur), ...rest.slice().reverse()));
      } catch {
        const parent = dirname(cur);
        if (parent === cur) return norm(p);
        rest.push(cur.slice(parent.length).replace(/^[\\/]+/, ""));
        cur = parent;
      }
    }
  };
  const expand = (p, base = cwd) => {
    const t = p.trim().replace(/^\$\{?HOME\}?(?=[\\/]|$)/, "~");
    if (t === "~") return home;
    if (t.startsWith("~/") || t.startsWith("~\\")) return join2(home, t.slice(2));
    return isAbsolute(t) ? t : resolve(base, t);
  };
  const inside = (p, dir) => p === dir || p.startsWith(dir.endsWith(sep) ? dir : dir + sep);
  const asset = real(meshworkHome(o.env, home));
  const claudeDir = real(join2(home, ".claude"));
  const plugins = [
    join2(home, ".claude", "plugins", "cache", "meshwork"),
    join2(home, ".claude", "plugins", "marketplaces", "meshwork"),
    ...o.env.CLAUDE_PLUGIN_ROOT ? [o.env.CLAUDE_PLUGIN_ROOT] : []
  ].map(real);
  const reaches = (p, base = cwd) => {
    const full = expand(p, base);
    if (!/[*?[{]/.test(full)) return inside(real(full), asset);
    return globReaches(full, asset, fold, real);
  };
  const parentOfAsset = (p, base = cwd) => {
    const r = real(expand(p, base));
    return r !== asset && inside(asset, r) && inside(r, claudeDir);
  };
  const file = FILE_TOOLS[tool];
  if (file) {
    const p = str(a[file.field]);
    if (!p) return null;
    if (reaches(p)) return REASON_ASSET;
    const target = real(expand(p));
    if (file.write && plugins.some((d) => inside(target, d))) return REASON_PLUGIN;
    if (file.write && isSettings(target) && disablesHooks(target, a)) return REASON_HOOKS;
    return null;
  }
  if (SEARCH_TOOLS.has(tool)) {
    const root = str(a.path) ?? cwd;
    if (reaches(root) || parentOfAsset(root)) return REASON_ASSET;
    const globs = [str(a.glob), tool === "Glob" ? str(a.pattern) : void 0].filter(
      (x) => !!x
    );
    for (const g of globs) if (reaches(g, expand(root))) return REASON_ASSET;
    return null;
  }
  const cmd = str(a.command);
  if (cmd !== void 0) {
    if (inside(real(cwd), asset)) return REASON_ASSET;
    return shellVerdict(cmd, { reaches, parentOfAsset, expand, cwd, plugins, real, inside });
  }
  for (const v of strings(a)) {
    const t = v.trim();
    if (/^([a-z]:)?[\\/~]|^\$\{?HOME\}?[\\/]/i.test(t) && !/\s/.test(t) && reaches(t))
      return REASON_ASSET;
  }
  return null;
}
function shellVerdict(cmd, x) {
  if (hooksOffInText(cmd) && /--settings\b|(settings(\.local)?|managed-settings)\.json/i.test(cmd))
    return REASON_HOOKS;
  if (/\bplugin\s+(disable|uninstall|remove)\b[^\n;&|]*\bmeshwork\b/i.test(cmd)) return REASON_HOOKS;
  const clean = cmd.replace(/\\(.)/g, "$1").replace(/["']/g, "").replace(/\$\{HOME\}|\$HOME/g, "~").replace(/([\\/])\.(?=[\\/])/g, "$1").replace(/([\\/]){2,}/g, "$1");
  let base = x.cwd;
  for (const part of clean.split(/&&|\|\||[;|&\n]/)) {
    const words = part.trim().split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    const verb = (words[0] ?? "").replace(/^.*[\\/]/, "");
    const bulk = BULK.has(verb);
    for (const w0 of words.slice(1)) {
      const w = w0.replace(/^[^=~/\\$]*=/, "");
      if (!bulk && !/[\\/~]|\.claude|meshwork|tokens\.json/i.test(w)) continue;
      if (w.startsWith("-")) continue;
      if (x.reaches(w, base)) return REASON_ASSET;
      if (bulk && x.parentOfAsset(w, base)) return REASON_ASSET;
      const r = x.real(x.expand(w, base));
      if (x.plugins.some((d) => x.inside(r, d))) return REASON_PLUGIN;
    }
    if ((verb === "cd" || verb === "pushd") && words[1]) base = x.expand(words[1], base);
  }
  return null;
}
function globReaches(full, asset, fold, real) {
  const split = (p) => p.split(/[\\/]+/).filter((s, i) => s || i === 0);
  const g = split(fold ? full.toLowerCase() : full);
  const first = g.findIndex((s) => /[*?[{]/.test(s));
  const fixed = real(g.slice(0, first).join("/") || "/");
  const pat = [...split(fixed), ...g.slice(first)];
  const target = split(asset);
  const seg = (s) => new RegExp(
    `^${s.replace(/[.+^$()|\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".").replace(/\{([^}]*)\}/g, (_m, alts) => `(${alts.split(",").join("|")})`)}$`
  );
  const walk = (i, j) => {
    if (j >= target.length) return true;
    if (i >= pat.length) return false;
    if (pat[i] === "**") return walk(i + 1, j) || walk(i, j + 1);
    return seg(pat[i]).test(target[j]) && walk(i + 1, j + 1);
  };
  return walk(0, 0);
}
function isSettings(p) {
  return /(^|[\\/])(settings(\.local)?|managed-settings)\.json$/i.test(p);
}
function offIn(obj) {
  const o = obj && typeof obj === "object" ? obj : {};
  const plugins = o.enabledPlugins && typeof o.enabledPlugins === "object" ? o.enabledPlugins : {};
  return {
    hooksOff: !!o.disableAllHooks || !!o.allowManagedHooksOnly,
    pluginOff: plugins["meshwork@meshwork"] === false,
    pluginOn: plugins["meshwork@meshwork"] === true
  };
}
function disablesHooks(path, a) {
  const read = () => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  };
  const parse = (t) => {
    try {
      return JSON.parse(t);
    } catch {
      return void 0;
    }
  };
  let before = null;
  let after;
  if (typeof a.content === "string") after = a.content;
  else {
    before = read();
    const edits = Array.isArray(a.edits) ? a.edits : [a];
    let t = before ?? "";
    for (const e of edits) {
      if (typeof e.old_string !== "string" || typeof e.new_string !== "string") continue;
      t = e.replace_all ? t.split(e.old_string).join(e.new_string) : t.replace(e.old_string, () => e.new_string);
    }
    after = t;
  }
  const was = before === null ? null : parse(before);
  const now = parse(after);
  if (now === void 0) return hooksOffInText(writtenText(a));
  const n = offIn(now);
  if (n.hooksOff || n.pluginOff) return true;
  if (was !== void 0 && was !== null && offIn(was).pluginOn && !n.pluginOn) return true;
  return false;
}
function writtenText(a) {
  const parts = [str(a.content), str(a.new_string)];
  if (Array.isArray(a.edits)) {
    for (const e of a.edits)
      if (e && typeof e === "object") parts.push(str(e.new_string));
  }
  return parts.filter(Boolean).join("\n");
}
function hooksOffInText(text) {
  const t = text.replace(
    /\\u([0-9a-fA-F]{4})/g,
    (_m, h) => String.fromCharCode(parseInt(h, 16))
  );
  if (/disableAllHooks|allowManagedHooksOnly/i.test(t)) return true;
  return /["']?meshwork@meshwork["']?\s*:\s*false/i.test(t);
}
function strings(v, depth = 0, out = []) {
  if (depth > 6 || out.length > 200) return out;
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, depth + 1, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) strings(x, depth + 1, out);
  return out;
}

// guard.ts
async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}
try {
  const input = JSON.parse(await readStdin());
  const reason = guard(input, { env: process.env });
  if (reason) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: reason
        }
      })
    );
  }
} catch {
}
