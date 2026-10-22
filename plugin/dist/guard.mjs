// core/guard.ts
import { realpathSync } from "node:fs";
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
var SHELL_TOOLS = /* @__PURE__ */ new Set(["Bash", "PowerShell"]);
var SEARCH_TOOLS = /* @__PURE__ */ new Set(["Grep", "Glob"]);
var OWN_MCP = /^mcp__plugin_meshwork_meshwork__/;
var str = (v) => typeof v === "string" ? v : void 0;
function guard(input, o) {
  const tool = str(input.tool_name);
  const args = input.tool_input;
  if (!tool || !args || typeof args !== "object") return null;
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
    let cur = p;
    const rest = [];
    for (; ; ) {
      try {
        return norm(join2(realpathSync(cur), ...rest.reverse()));
      } catch {
        const parent = dirname(cur);
        if (parent === cur) return norm(p);
        rest.push(cur.slice(parent.length).replace(/^[\\/]+/, ""));
        cur = parent;
      }
    }
  };
  const expand = (p) => {
    const t = p.trim();
    if (t === "~") return home;
    if (t.startsWith("~/") || t.startsWith("~\\")) return join2(home, t.slice(2));
    return isAbsolute(t) ? t : resolve(cwd, t);
  };
  const inside = (p, dir) => p === dir || p.startsWith(dir.endsWith(sep) ? dir : dir + sep);
  const asset = real(meshworkHome(o.env, home));
  const claudeDir = real(join2(home, ".claude"));
  const plugins = [
    join2(home, ".claude", "plugins", "cache", "meshwork"),
    join2(home, ".claude", "plugins", "marketplaces", "meshwork"),
    ...o.env.CLAUDE_PLUGIN_ROOT ? [o.env.CLAUDE_PLUGIN_ROOT] : []
  ].map(real);
  const touchesAsset = (p) => inside(real(expand(p)), asset);
  const file = FILE_TOOLS[tool];
  if (file) {
    const p = str(a[file.field]);
    if (!p) return null;
    const target = real(expand(p));
    if (inside(target, asset)) return REASON_ASSET;
    if (file.write && plugins.some((d) => inside(target, d))) return REASON_PLUGIN;
    if (file.write && isSettings(target) && disablesHooks(writtenText(a))) return REASON_HOOKS;
    return null;
  }
  if (SEARCH_TOOLS.has(tool)) {
    const root = real(expand(str(a.path) ?? cwd));
    if (inside(root, asset)) return REASON_ASSET;
    if (inside(asset, root) && inside(root, claudeDir)) return REASON_ASSET;
    for (const pat of [str(a.pattern), str(a.glob)]) {
      if (pat && mentionsAsset(pat, fold)) return REASON_ASSET;
      if (tool === "Glob" && pat && isAbsolute(pat) && touchesAsset(staticPrefix(pat)))
        return REASON_ASSET;
    }
    return null;
  }
  if (SHELL_TOOLS.has(tool)) {
    const cmd = str(a.command);
    if (!cmd) return null;
    const c = fold ? cmd.toLowerCase() : cmd;
    if (mentionsAsset(cmd, fold) || c.includes(asset)) return REASON_ASSET;
    if (/plugins[\\/](cache|marketplaces)[\\/]meshwork\b/i.test(cmd)) return REASON_PLUGIN;
    if (disablesHooks(cmd)) return REASON_HOOKS;
    if (/\bplugin\s+(disable|uninstall|remove)\b[^\n;&|]*\bmeshwork\b/i.test(cmd))
      return REASON_HOOKS;
    return null;
  }
  if (tool.startsWith("mcp__") && !OWN_MCP.test(tool)) {
    for (const v of strings(a)) {
      if (mentionsAsset(v, fold)) return REASON_ASSET;
      if (/^([a-z]:)?[\\/~]/i.test(v.trim()) && touchesAsset(v)) return REASON_ASSET;
    }
  }
  return null;
}
function mentionsAsset(text, fold) {
  const t = fold ? text.toLowerCase() : text;
  return /channels[\\/]+meshwork(?![\w-])/.test(t);
}
function isSettings(p) {
  return /(^|[\\/])(settings(\.local)?|managed-settings)\.json$/i.test(p);
}
function writtenText(a) {
  const parts = [str(a.content), str(a.new_string)];
  if (Array.isArray(a.edits)) {
    for (const e of a.edits)
      if (e && typeof e === "object") parts.push(str(e.new_string));
  }
  return parts.filter(Boolean).join("\n");
}
function disablesHooks(text) {
  if (/disableAllHooks|allowManagedHooksOnly/i.test(text)) return true;
  return /["']meshwork@meshwork["']\s*:\s*false/i.test(text);
}
function staticPrefix(pattern) {
  const i = pattern.search(/[*?[{]/);
  return i < 0 ? pattern : dirname(pattern.slice(0, i) + "x");
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
