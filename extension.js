// 迪克的黑调
//
// 录制：在完整代码里选中一段 → 「录制选中代码」，代码被存进 .dick-black-tune/snippets.json，原位置只留一个空行，
//       同时记下这个空行上下的代码，作为以后找回位置的依据。
// 演示：开启演示模式后，在演示文件里点一下某个空行开始按键，插件按上下文认出这里该打哪一段，
//       不管按什么键都只打出这一段代码；打完点下一个空行接着按。全部打完后键盘自动恢复正常。
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const MANIFEST_DIR = '.dick-black-tune';
const LEGACY_DIR = '.demo-typer'; // 改名前（演示打字机）用的目录，第一次用到时自动改名过来
const MANIFEST_FILE = 'snippets.json';

let ctx;
let tree;
let statusItem;
let armed = false; // 演示模式
let typeOverride = null; // 演示模式期间接管的 "type" 命令
let imeOverrides = []; // 接管输入法的开始/结束，用来知道演示者正在用输入法打字
let composing = false; // 输入法正在拼写（拼音还没上屏）
let swallowing = false; // 正在打代码时误开了中文输入法：这次拼写整个吞掉

function imeSwallow() {
  const editor = vscode.window.activeTextEditor;
  return !!(armed && session && !session.done && !session.paused && !session.human && editor && editor.document === session.editor.document);
}
let typed = new Set(); // 本轮演示已经打完的片段 id
let session = null; // 正在打的片段

// 改名前（演示打字机）的用户设置搬到新名字下面，只搬一次、不覆盖已有的
async function migrateSettings() {
  const oldCfg = vscode.workspace.getConfiguration('demo' + 'Typer');
  const newCfg = vscode.workspace.getConfiguration('dickBlackTune');
  const keys = ['chunkSize', 'typingDelay', 'completion', 'completionPause', 'completionChance', 'chineseMode', 'chineseHint', 'imeTheme', 'imeStyle'];
  for (const key of keys) {
    try {
      const old = oldCfg.inspect(key);
      const now = newCfg.inspect(key);
      if (old && old.globalValue !== undefined && (!now || now.globalValue === undefined)) {
        await newCfg.update(key, old.globalValue, vscode.ConfigurationTarget.Global);
      }
    } catch (err) { /* 搬不了就用默认值 */ }
  }
}

function activate(context) {
  ctx = context;
  migrateSettings();
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 101);
  tree = new PanelProvider(context.extensionUri);
  const reg = (id, fn) => vscode.commands.registerCommand(id, fn);
  context.subscriptions.push(
    statusItem,
    vscode.window.registerWebviewViewProvider('dickBlackTune.panel', tree, { webviewOptions: { retainContextWhenHidden: true } }),
    reg('dickBlackTune.toggleDemo', () => setArmed(!armed)),
    reg('dickBlackTune.startDemo', () => setArmed(true)),
    reg('dickBlackTune.stopDemo', () => setArmed(false)),
    reg('dickBlackTune.record', recordSelection),
    reg('dickBlackTune.reset', resetDocument),
    reg('dickBlackTune.restore', restoreDocument),
    reg('dickBlackTune.restoreOriginal', () => restoreOriginal().then(() => tree.refresh())),
    reg('dickBlackTune.deleteAll', () => deleteAll().then(() => { refreshContexts(); tree.refresh(); })),
    reg('dickBlackTune.openManifest', openManifest),
    reg('dickBlackTune.refresh', () => { refreshContexts(); tree.refresh(); }),
    reg('dickBlackTune.reveal', revealSnippet),
    reg('dickBlackTune.key', (args) => onKey(args || {})),
    reg('dickBlackTune.escape', () => pauseSession()),
    vscode.window.onDidChangeActiveTextEditor(() => { refreshContexts(); tree.refresh(); }),
    vscode.window.onDidChangeTextEditorSelection(() => tree.refreshSoon()),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (session && session.paused && session.settled && e.document === session.editor.document) shiftPausedSession(e.contentChanges);
      else if (session && e.contentChanges.length && e.document === session.editor.document) checkForeignEdit(session);
      if (e.document === (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document)) tree.refreshSoon();
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (path.basename(doc.fileName) === MANIFEST_FILE) { refreshContexts(); tree.refresh(); }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('dickBlackTune')) { systemDark = null; updateStatus(); tree.refresh(); }
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      if (session && doc === session.editor.document) endSession();
    }),
    { dispose: () => setArmed(false) },
  );
  // 用户在「键盘快捷方式」里改了快捷键，面板跟着更新
  const kbFile = userKeybindingsFile();
  if (kbFile) {
    fs.watchFile(kbFile, { interval: 1500 }, () => tree.refresh());
    context.subscriptions.push({ dispose: () => fs.unwatchFile(kbFile) });
  }
  refreshContexts();
  return { panel: tree, panelState: () => panelState(), statusText: () => statusItem.text, zoomFactor: () => vscodeZoomFactor() };
}

function deactivate() {
  setArmed(false);
}

// ---------- 片段配置 .dick-black-tune/snippets.json ----------

function rootFor(uri) {
  const folder = uri && vscode.workspace.getWorkspaceFolder(uri);
  if (folder) return folder.uri.fsPath;
  if (uri && uri.scheme === 'file') return path.dirname(uri.fsPath);
  const first = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  return first ? first.uri.fsPath : '';
}

// 工作区里放片段配置和备份的目录；旧版本的 .demo-typer 自动改名成新目录
function dataDir(root) {
  const dir = path.join(root, MANIFEST_DIR);
  const legacy = path.join(root, LEGACY_DIR);
  if (!fs.existsSync(dir) && fs.existsSync(path.join(legacy, MANIFEST_FILE))) {
    try { fs.renameSync(legacy, dir); } catch (err) { return legacy; }
  }
  return dir;
}

function manifestPath(root) {
  return root ? path.join(dataDir(root), MANIFEST_FILE) : '';
}

const manifestCache = new Map(); // 文件路径 -> { mtime, size, raw }
function readManifestRaw(file) {
  const st = fs.statSync(file);
  const hit = manifestCache.get(file);
  if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return hit.raw;
  const raw = fs.readFileSync(file, 'utf8');
  manifestCache.set(file, { mtime: st.mtimeMs, size: st.size, raw });
  return raw;
}

function loadManifest(root) {
  const file = manifestPath(root);
  if (!file || !fs.existsSync(file)) return { version: 1, snippets: [] };
  try {
    const data = JSON.parse(readManifestRaw(file));
    data.snippets = Array.isArray(data.snippets) ? data.snippets : [];
    return data;
  } catch (err) {
    vscode.window.showErrorMessage(`片段配置文件格式不对：${file}（${err.message}）`);
    return { version: 1, snippets: [] };
  }
}

function saveManifest(root, data) {
  const file = manifestPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

// 录制前的原文件备份：.dick-black-tune/backups/<文件路径>.orig
function backupPath(root, target) {
  const dir = path.join(dataDir(root), 'backups');
  const file = path.join(dir, encodeURIComponent(target) + '.orig');
  const legacy = path.join(dir, target.split('/').join('__') + '.orig');
  return !fs.existsSync(file) && fs.existsSync(legacy) ? legacy : file;
}

function relTarget(root, doc) {
  return path.relative(root, doc.uri.fsPath).split(path.sep).join('/');
}

function snippetsFor(doc) {
  if (!doc || doc.uri.scheme !== 'file') return [];
  const root = rootFor(doc.uri);
  const rel = relTarget(root, doc);
  const base = path.basename(doc.uri.fsPath);
  return loadManifest(root).snippets.filter((s) => s.target === rel
    || (path.basename(s.target || '') === base && !fs.existsSync(path.join(root, s.target || ''))));
}

const norm = (s) => s.replace(/\r\n?/g, '\n');

// ---------- 位置上下文：靠空行上面最近的两行、下面最近的一行认出该打哪一段 ----------

function contextAt(doc, line) {
  const before = [];
  for (let l = line - 1; l >= 0 && before.length < 2; l--) {
    const t = doc.lineAt(l).text.trim();
    if (t) before.push(t);
  }
  let after = '';
  for (let l = line + 1; l < doc.lineCount; l++) {
    const t = doc.lineAt(l).text.trim();
    if (t) { after = t; break; }
  }
  return { before, after };
}

function scoreAt(doc, line, snippet) {
  const c = contextAt(doc, line);
  let score = 0;
  (snippet.before || []).forEach((t, i) => { if (c.before[i] === t) score += i === 0 ? 2 : 1; });
  if (snippet.after && c.after === snippet.after) score += 2;
  return score;
}

// 当前光标所在的空行该打哪一段：上下文最吻合的那段；都对不上时按录制顺序取下一段
function pickSnippet(editor) {
  const doc = editor.document;
  const line = editor.selection.active.line;
  if (!doc.lineAt(line).isEmptyOrWhitespace) return null;
  const text = norm(doc.getText());
  const pending = snippetsFor(doc).filter((s) => !typed.has(s.id) && findCode(text, s.code) < 0);
  if (!pending.length) return null;
  let best = null;
  let bestScore = 1; // 至少上面紧挨的一行或下面一行要对上，免得在随便一个空行上开打
  for (const s of pending) {
    const sc = scoreAt(doc, line, s);
    if (sc > bestScore) { best = s; bestScore = sc; }
  }
  return best;
}

// 在文件里找最适合放这一段的空行（还原、定位时用）
function bestBlankLine(doc, snippet) {
  let best = -1;
  let bestScore = 0;
  for (let l = 0; l < doc.lineCount; l++) {
    if (!doc.lineAt(l).isEmptyOrWhitespace) continue;
    const sc = scoreAt(doc, l, snippet);
    if (sc > bestScore) { best = l; bestScore = sc; }
  }
  return best < 0 ? best : landingLine(doc, best, snippet);
}

// 连着好几行空行时，按原文件里这段代码上方有几行空行来落位，函数、段落之间的空行和原来一模一样
function landingLine(doc, line, snippet) {
  if (typeof snippet.blankBefore !== 'number') return line;
  let first = line;
  while (first > 0 && doc.lineAt(first - 1).isEmptyOrWhitespace) first--;
  let last = line;
  while (last + 1 < doc.lineCount && doc.lineAt(last + 1).isEmptyOrWhitespace) last++;
  return Math.min(first + snippet.blankBefore, last);
}

// ---------- 录制 ----------

// 一次可以选中多段（按住 Option 拖选）：每一段各存成一个片段
async function recordSelection() {
  const editor = vscode.window.activeTextEditor;
  const sels = editor ? editor.selections.filter((s) => !s.isEmpty) : [];
  if (!sels.length) {
    vscode.window.showErrorMessage('先选中要录制的代码（整行选中即可，按住 Option 拖选可以一次选多段）。');
    return;
  }
  const doc = editor.document;
  if (doc.uri.scheme !== 'file') {
    vscode.window.showErrorMessage('请先保存这个文件，再录制。');
    return;
  }

  // 每一段换算成整行范围，去掉首尾空行，重叠的合并掉
  const ranges = [];
  for (const sel of sels) {
    let first = sel.start.line;
    let last = sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line - 1 : sel.end.line;
    while (first < last && doc.lineAt(first).isEmptyOrWhitespace) first++;
    while (last > first && doc.lineAt(last).isEmptyOrWhitespace) last--;
    if (doc.lineAt(first).isEmptyOrWhitespace && first === last) continue;
    ranges.push({ first, last });
  }
  ranges.sort((a, b) => a.first - b.first);
  const merged = [];
  for (const r of ranges) {
    const prev = merged[merged.length - 1];
    if (prev && r.first <= prev.last + 1) prev.last = Math.max(prev.last, r.last);
    else merged.push({ ...r });
  }
  if (!merged.length) {
    vscode.window.showErrorMessage('选中的都是空行。');
    return;
  }

  // 从下往上处理，删掉下面的代码不会影响上面的行号
  const root = rootFor(doc.uri);
  const backup = backupPath(root, relTarget(root, doc));
  if (!fs.existsSync(backup)) {
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    fs.writeFileSync(backup, doc.getText(), 'utf8');
  }
  const comment = lineCommentFor(doc.languageId);
  const recorded = [];
  for (const { first, last } of merged.slice().reverse()) {
    const range = new vscode.Range(first, 0, last, doc.lineAt(last).text.length);
    const code = norm(doc.getText(range));
    let blankBefore = 0;
    while (first - blankBefore - 1 >= 0 && doc.lineAt(first - blankBefore - 1).isEmptyOrWhitespace) blankBefore++;
    // 代码从文件里拿掉，只留一个空行：这就是台上要点的位置
    await editor.edit((b) => b.replace(range, ''));
    const c = contextAt(doc, first);
    recorded.unshift({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      name: nameFor(c.before[0], code, comment),
      target: relTarget(root, doc),
      before: c.before,
      after: c.after,
      blankBefore,
      code,
    });
  }
  const pos = new vscode.Position(merged[0].first, 0);
  editor.selection = new vscode.Selection(pos, pos);

  const data = loadManifest(root);
  data.snippets.push(...recorded);
  saveManifest(root, data);
  await saveDoc(doc);
  refreshContexts();
  tree.refresh();
  notify('$(record)', recorded.length === 1 ? `已录制「${recorded[0].name}」` : `已录制 ${recorded.length} 段`);
}

function nameFor(prevLine, code, comment) {
  if (prevLine && comment && prevLine.startsWith(comment)) {
    return prevLine.slice(comment.length).trim().slice(0, 40);
  }
  return code.split('\n').map((l) => l.trim()).find(Boolean).slice(0, 40);
}

// ---------- 重置 / 还原 ----------

// 把本文件里已经打出来的片段代码删掉，回到演示前的样子（每段只留一个空行）
async function resetDocument() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  if (session) endSession();
  await cleanup;
  const doc = editor.document;
  let removed = 0;
  for (const s of snippetsFor(doc)) {
    const text = norm(doc.getText());
    const at = findCode(text, s.code);
    if (at < 0) continue;
    const start = normPos(text, at);
    const end = normPos(text, at + s.code.length);
    await editor.edit((b) => b.replace(new vscode.Range(start, end), ''));
    removed++;
  }
  // 打了一半、或者打乱了的，也清掉，只留一个空行
  for (const s of snippetsFor(doc)) {
    const r = partialRange(doc, s);
    if (!r) continue;
    await editor.edit((b) => b.replace(r, ''));
    removed++;
  }
  typed = new Set([...typed].filter((id) => !snippetsFor(doc).some((s) => s.id === id)));
  await saveDoc(doc);
  tree.refresh();
  updateStatus();
  notify('$(discard)', `已重置，删掉了 ${removed} 段代码`);
}

// 打了一半、或被打乱的片段：在它上下文锚点之间（本该只有空行的地方）出现了内容，返回这些内容所在的整行范围
function partialInfo(doc, s) {
  const text = norm(doc.getText());
  if (findCode(text, s.code) >= 0) return null;
  // 别的片段完整地在文件里时，绝不碰它们
  const others = [];
  for (const o of snippetsFor(doc)) {
    if (o.id === s.id) continue;
    const at = findCode(text, o.code);
    if (at >= 0) others.push([normPos(text, at).line, normPos(text, at + o.code.length).line]);
  }
  const before = s.before || [];
  const maxSpan = s.code.split('\n').length + 30;
  const trimAt = (l) => doc.lineAt(l).text.trim();
  const anchors = [];
  if (!before.length) anchors.push(-1);
  else {
    // 上面紧挨的那行必须对上；再上一行可能是别的还没打的片段，对不上也行，只是排在后面
    const weak = [];
    for (let l = 0; l < doc.lineCount; l++) {
      if (trimAt(l) !== before[0]) continue;
      let p = l - 1;
      while (p >= 0 && !trimAt(p)) p--;
      if (before[1] === undefined || (p >= 0 && trimAt(p) === before[1])) anchors.push(l);
      else weak.push(l);
    }
    anchors.strong = anchors.length;
    anchors.push(...weak);
  }
  const strongCount = anchors.strong === undefined ? anchors.length : anchors.strong;
  for (let ai = 0; ai < anchors.length; ai++) {
    const anchor = anchors[ai];
    // 下面那行可能出现好几次：打了一半的代码里，被挪到下面单独一行的右括号（如「}」）也可能长得和它一样。
    // 依次试每个候选：内容确实是这一段开头的那个优先；都不是时只拿第一个去判断「是不是打乱了」
    const ends = [];
    if (s.after) {
      for (let m = anchor + 1; m < doc.lineCount && m <= anchor + maxSpan; m++) if (trimAt(m) === s.after) ends.push(m);
    } else ends.push(Math.min(doc.lineCount, anchor + 1 + maxSpan));
    let fallback = null;
    for (let ei = 0; ei < ends.length; ei++) {
      const end = ends[ei];
      let a = -1;
      let b = -1;
      for (let m = anchor + 1; m < end; m++) {
        if (!trimAt(m)) continue;
        if (a < 0) a = m;
        b = m;
      }
      if (a < 0) continue;
      if (others.some(([x0, x1]) => x0 <= b && x1 >= a)) continue;
      const range = new vscode.Range(a, 0, b, doc.lineAt(b).text.length);
      // 区域里的内容必须真像这一段打出来的：是它的开头；或者（上下文完全对上时）第一行开头和它一样、只是后面打乱了。
      // 否则可能是别人的代码（Go 里满是「}」「)」这样的行），绝不能当成打了一半去清掉
      const prefix = typedPrefix(doc, s, range);
      // anchor/end：这一段该待的区域（不含），range：区域里已经有的内容
      if (prefix && prefix.len > 0) return { range, anchor, end, prefix };
      if (ei === 0) {
        const firstHave = doc.lineAt(a).text.trim();
        const firstCode = norm(s.code).split('\n')[0].trim();
        const need = Math.min(4, firstCode.length);
        // 上面两行都对上（或上面一行和下面一行都对上），首行开头一样，而且整体只差几个字（打字时撞乱的样子）；
        // 手工改写过的代码差得多，不算
        const looksLike = (ai < strongCount || !!s.after) && firstHave.slice(0, need) === firstCode.slice(0, need)
          && nearPrefix(norm(doc.getText(range)), norm(s.code));
        if (looksLike) fallback = { range, anchor, end, prefix: null };
      }
    }
    if (fallback) return fallback;
  }
  return null;
}

function partialRange(doc, s) {
  const info = partialInfo(doc, s);
  return info ? info.range : null;
}

// 光标点在某段「打了一半」的片段所在区域里（它上下文锚点之间）：返回这一段和它的位置
function findPartialAt(editor) {
  const doc = editor.document;
  const line = editor.selection.active.line;
  for (const s of snippetsFor(doc)) {
    const info = partialInfo(doc, s);
    if (info && line > info.anchor && line < info.end) return { snippet: s, info };
  }
  return null;
}

// 文件里已有的内容是不是这一段的开头：是的话算出打到第几个字，以及后面已经自动补上的右括号/右引号
function typedPrefix(doc, snippet, range) {
  const text = norm(snippet.code);
  const have = norm(doc.getText(range));
  const pairs = scanSyntax(text, doc.languageId).pairs;
  const tail = have.match(/[)\]}"'`\s]*$/)[0];
  for (let m = 0; m <= tail.length; m++) {
    const p = have.slice(0, have.length - m);
    if (!text.startsWith(p)) continue;
    // 左边已经打了、右边还没打到的那些括号，编辑器里应该已经补在光标后面（里层的在前）；
    // 有的已经被挪到了下面单独一行（{|} 中间回车时），那它在原文里也得是那一行的开头、缩进一样
    const pending = [...pairs].filter(([o, c]) => o < p.length && c >= p.length).map(([, c]) => c).sort((a, b) => a - b);
    const rest = have.slice(p.length);
    if (pending.map((c) => text[c]).join('') !== rest.replace(/\s/g, '')) continue;
    const pre = [];
    let ok = true;
    let k = 0;
    for (const c of pending) {
      const at = rest.indexOf(text[c], k);
      const between = rest.slice(k, at);
      if (between.includes('\n')) {
        const n0 = text.lastIndexOf('\n', c - 1);
        const ind = text.slice(n0 + 1, c);
        if (n0 < p.length || !/^[ \t]*$/.test(ind) || !between.endsWith('\n' + ind) || between.slice(0, -ind.length - 1).replace(/[ \t]/g, '')) { ok = false; break; }
        pre.push(n0);
      } else if (between) { ok = false; break; }
      k = at + 1;
    }
    if (!ok) continue;
    return { len: p.length, pending, pre };
  }
  return null;
}

// have 和片段某个开头只差几个字（编辑距离不超过 max(3, 15%)）：判断「打乱了」还是「人手改过」
function nearPrefix(have, code) {
  const a = have.slice(0, 400);
  const limit = Math.max(3, Math.floor(a.length * 0.15));
  const lev = (s, t) => {
    let prev = Array.from({ length: t.length + 1 }, (_, j) => j);
    for (let i = 1; i <= s.length; i++) {
      const cur = [i];
      for (let j = 1; j <= t.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (s[i - 1] === t[j - 1] ? 0 : 1));
      prev = cur;
    }
    return prev[t.length];
  };
  for (let k = Math.max(0, a.length - limit); k <= Math.min(code.length, a.length + limit); k++) {
    if (lev(a, code.slice(0, k)) <= limit) return true;
  }
  return false;
}

// findCode 等用的是换行归一成 \n 之后的文本；CRLF 文件里不能把这个下标直接交给 doc.positionAt
function normPos(normText, offset) {
  const before = normText.slice(0, offset);
  const line = (before.match(/\n/g) || []).length;
  return new vscode.Position(line, offset - (before.lastIndexOf('\n') + 1));
}

// 从 pos 往后走过一段（已归一的）文本，得到末尾位置
function advancePos(pos, s) {
  const parts = s.split('\n');
  return parts.length === 1 ? pos.translate(0, s.length) : new vscode.Position(pos.line + parts.length - 1, parts[parts.length - 1].length);
}

// 插件自己保存文件时跳过「保存时格式化 / 整理 import」，免得 Go、Python 插件把只在片段里用到的 import 删掉
async function saveDoc(doc) {
  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document === doc) await vscode.commands.executeCommand('workbench.action.files.saveWithoutFormatting');
  else await saveDoc(doc);
}

// 片段代码必须从行首开始、到行尾结束才算（避免误删别处碰巧相同的文字）
function findCode(text, code) {
  let from = 0;
  for (;;) {
    const at = text.indexOf(code, from);
    if (at < 0) return -1;
    const startOk = at === 0 || text[at - 1] === '\n';
    const endOk = at + code.length === text.length || text[at + code.length] === '\n';
    if (startOk && endOk) return at;
    from = at + 1;
  }
}

// 把还没打的片段一次性填回去（检查代码、运行程序时用）
async function restoreDocument() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  if (session) endSession();
  await cleanup;
  const doc = editor.document;
  let filled = 0;
  for (const s of snippetsFor(doc)) {
    if (findCode(norm(doc.getText()), s.code) >= 0) continue;
    const half = partialRange(doc, s);
    const line = half ? -1 : bestBlankLine(doc, s);
    if (!half && line < 0) continue;
    await editor.edit((b) => b.replace(half || doc.lineAt(line).range, s.code));
    filled++;
  }
  await saveDoc(doc);
  notify('$(check-all)', `已填回 ${filled} 段代码`);
}

async function openManifest() {
  const editor = vscode.window.activeTextEditor;
  const root = rootFor(editor && editor.document.uri);
  const file = manifestPath(root);
  if (!file || !fs.existsSync(file)) {
    vscode.window.showErrorMessage('这个工作区还没有录制过片段。');
    return;
  }
  await vscode.window.showTextDocument(vscode.Uri.file(file));
}

async function revealSnippet(snippet) {
  if (!snippet) return;
  const root = rootFor(vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri);
  const file = path.join(root, snippet.target);
  if (!fs.existsSync(file)) {
    vscode.window.showErrorMessage(`找不到演示文件：${file}`);
    return;
  }
  const editor = await vscode.window.showTextDocument(vscode.Uri.file(file));
  const line = bestBlankLine(editor.document, snippet);
  if (line >= 0) {
    const pos = new vscode.Position(line, 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
  }
}

// ---------- 演示模式 ----------

function setArmed(on) {
  if (on === armed) return;
  armed = on;
  if (on) {
    typed = new Set();
    try {
      // 接管 "type"：编辑器里每一次字符输入都会先到这里；不在演示文件里时原样交还给编辑器
      typeOverride = vscode.commands.registerCommand('type', (args) => onKey({ fallback: 'type', text: args && args.text }));
      // 拼音输入法打第一个字母时，编辑器会把这个字母当普通按键送过来；靠输入法的开始/结束事件把它和真的英文按键区分开
      imeOverrides = [
        vscode.commands.registerCommand('compositionStart', (args) => {
          // 正在打代码时误开了中文输入法（碰到 Caps Lock、Shift 切换等）：拼写过程全吞掉，每次变化当成一次按键，
          // 不让随机汉字进代码。只有「停下来等你打中文」时才真的交给输入法
          if (imeSwallow()) { swallowing = true; return undefined; }
          composing = true;
          if (session && session.human) clearHumanHint(session); // 开始拼写了，灰字提示收起来，免得和输入法叠在一起
          return vscode.commands.executeCommand('default:compositionStart', args);
        }),
        vscode.commands.registerCommand('compositionEnd', async (args) => {
          if (swallowing) { swallowing = false; return; }
          composing = false;
          await vscode.commands.executeCommand('default:compositionEnd', args);
          if (session && session.human) updateHumanHint(session);
        }),
        vscode.commands.registerCommand('compositionType', (args) => (swallowing ? step() : vscode.commands.executeCommand('default:compositionType', args))),
        vscode.commands.registerCommand('replacePreviousChar', (args) => (swallowing ? step() : vscode.commands.executeCommand('default:replacePreviousChar', args))),
      ];
    } catch (err) {
      armed = false;
      vscode.window.showErrorMessage('无法接管键盘输入：可能和 Vim 等也接管输入的插件冲突，请先禁用它们。');
      return;
    }
  } else {
    endSession();
    if (typeOverride) typeOverride.dispose();
    typeOverride = null;
    imeOverrides.forEach((d) => d.dispose());
    imeOverrides = [];
    composing = false;
    swallowing = false;
  }
  vscode.commands.executeCommand('setContext', 'dickBlackTune.armed', armed);
  refreshContexts();
  tree.refresh();
  updateStatus();
  flashToggle(on);
}

function refreshContexts() {
  const editor = vscode.window.activeTextEditor;
  // 只有这个文件还有没打完的片段（或正在打）时才接管回车、Tab、退格；全打完后这些键完全还给编辑器
  let capturing = false;
  if (armed && editor) {
    const mine = snippetsFor(editor.document);
    if (session && session.editor.document === editor.document && !session.done) capturing = true;
    else if (mine.length) {
      const text = norm(editor.document.getText());
      capturing = mine.some((s) => findCode(text, s.code) < 0);
    }
  }
  vscode.commands.executeCommand('setContext', 'dickBlackTune.capturing', capturing);
  vscode.commands.executeCommand('setContext', 'dickBlackTune.typing', !!(session && !session.done && !session.paused));
  updateStatus();
}

async function passthrough(args) {
  if (args.fallback === 'type') {
    const editor = vscode.window.activeTextEditor;
    const version = editor && editor.document.version;
    await vscode.commands.executeCommand('default:type', { text: args.text });
    // 窗口不在前台等极少数情况下编辑器会忽略这次输入：直接插入，保证按键不丢
    if (editor && args.text && editor.document.version === version) {
      await editor.edit((b) => editor.selections.forEach((s) => b.replace(s, args.text)));
    }
    return;
  }
  if (args.fallback) return vscode.commands.executeCommand(args.fallback);
}

// 每一次按键（字符键、回车、退格、Tab）都走这里
async function onKey(args) {
  const editor = vscode.window.activeTextEditor;
  if (!armed || !editor || composing) return passthrough(args);

  if (session && session.editor.document === editor.document) {
    if (session.paused) {
      const at = editor.selection.active;
      const back = session.human ? at.line === session.human.startPos.line : at.isEqual(session.cursor);
      if (back) { // 光标还在原处（或点回了原处）：接着打
        session.paused = false;
        session.settled = false;
        if (session.human) showHumanHint(session);
        if (session.ime) showComposition(session);
        refreshContexts();
        tree.refreshSoon();
        return session.human ? humanKey(session, args) : step();
      }
      // 点在暂停的这一段附近（比如它下面的空行）：回到停下的地方接着打
      const near = findPartialAt(editor);
      if (near && near.snippet.id === session.snippet.id && !session.human) {
        editor.selection = new vscode.Selection(session.cursor, session.cursor);
        session.paused = false;
        session.settled = false;
        if (session.ime) showComposition(session);
        refreshContexts();
        tree.refreshSoon();
        return step();
      }
      // 在别处：空行上有别的片段就开始那一段，否则正常打字，暂停的这段留着，点回原处还能继续
      const other = pickSnippet(editor);
      if (other && other.id === session.snippet.id) {
        // 点在这一段该在的空行上：回到停下的地方接着打
        editor.selection = new vscode.Selection(session.cursor, session.cursor);
        session.paused = false;
        session.settled = false;
        if (session.human) showHumanHint(session);
        if (session.ime) showComposition(session);
        refreshContexts();
        tree.refreshSoon();
        return session.human ? humanKey(session, args) : step();
      }
      if (!other) return passthrough(args);
      endSession();
      await self(() => beginSession(editor, other));
      return step();
    }
    if (session.human) return humanKey(session, args);
    if (!session.done) {
      session.lastKeyAt = Date.now();
      if (args.fallback === 'deleteLeft') return stepBack(); // 退格就是退格：删掉上一个字
      if (args.fallback === 'deleteRight') return undefined; // Delete：光标后面没东西可删，什么也不发生
      return step(); // 正在打或正在收尾
    }
    // 刚打完一段、光标还停在结尾：手还在连着乱按时多出来的键吞掉；停手一会儿再按，就是正常打字（可以退格改代码）
    if (editor.selection.active.isEqual(session.cursor) && Date.now() - (session.lastKeyAt || 0) < 900) {
      session.lastKeyAt = Date.now();
      return;
    }
    endSession();
  }
  await cleanup;

  // 点在一段打了一半的代码附近：从断点接着打，不再从头另起一份
  const partial = findPartialAt(editor);
  if (partial) {
    await self(() => resumePartial(editor, partial.snippet, partial.info));
    return step();
  }

  const snippet = pickSnippet(editor);
  if (!snippet) return passthrough(args);
  await self(() => beginSession(editor, snippet));
  return step();
}

// ---------- 打字途中，文件被插件以外的操作改了（⌘Z、粘贴、⌘⌫、保存时格式化……）----------
// 插件自己的改动都包在 self() 里；其它时候出现的改动就是别人改的：立刻结束这一段，免得按旧位置接着打、
// 收尾时还把挤进来的真代码整块换掉。之后再按键，会按文件里实际的内容重新认出打到哪、接着打
let selfDepth = 0;
let selfUntil = 0;
async function self(fn) {
  selfDepth++;
  try { return await fn(); } finally { selfDepth--; selfUntil = Date.now() + 80; }
}

function checkForeignEdit(current) {
  if (current.done || current.paused || current.human) return; // 等中文时，演示者用输入法改是正常的
  if (selfDepth > 0 || Date.now() < selfUntil) return;
  endSession();
}

// Esc：暂停这一段，已经打出来的留着；光标还在原处时再按键就接着打
async function pauseSession() {
  const current = session;
  if (!current || current.done || current.paused) return;
  current.paused = true;
  current.word = null;
  clearComposition(current);
  // 等手上这个字打完，之后文件里的改动才是演示者在别处改的
  await current.queue.catch(() => {});
  if (session !== current || !current.paused) return;
  // 拼音打到一半：像真输入法按 Esc 一样，把还没上屏的拼音整段撤掉，接着打时这一组重新拼
  if (current.ime && current.ime.shown) {
    const ime = current.ime;
    const range = new vscode.Range(ime.start, ime.start.translate(0, ime.shown.length));
    if (current.editor.document.getText(range) === ime.shown) {
      await self(() => current.editor.edit((b) => b.delete(range), { undoStopBefore: false, undoStopAfter: false }));
    }
    current.ime = null;
    current.cursor = ime.start;
  }
  current.settled = true;
  clearHumanHint(current);
  await hideSuggest(current);
  if (current.hintClosers.size) await vscode.commands.executeCommand('closeParameterHints');
  refreshContexts();
  tree.refresh();
}

// 暂停期间在别处改了文件（比如上面加了几行）：把这一段的位置跟着挪，点回去还能接上
function shiftPos(pos, change) {
  const { range, text } = change;
  if (pos.isBefore(range.start) || (pos.isEqual(range.start) && range.isEmpty && !text)) return pos;
  if (pos.isBefore(range.end)) return range.start;
  const lines = text.split('\n');
  const endLine = range.start.line + lines.length - 1;
  const endChar = lines.length === 1 ? range.start.character + text.length : lines[lines.length - 1].length;
  if (pos.line === range.end.line) return new vscode.Position(endLine, endChar + pos.character - range.end.character);
  return new vscode.Position(pos.line + endLine - range.end.line, pos.character);
}

function shiftPausedSession(changes) {
  const s = session;
  // 从后往前应用（contentChanges 里的范围都是相对改动前的文档）
  const list = changes.slice().sort((a, b) => b.range.start.compareTo(a.range.start));
  for (const c of list) {
    s.startPos = shiftPos(s.startPos, c);
    s.cursor = shiftPos(s.cursor, c);
    if (s.human) s.human.startPos = shiftPos(s.human.startPos, c);
    if (s.ime) s.ime.start = shiftPos(s.ime.start, c);
  }
}

let cleanup = Promise.resolve(); // 结束会话时清掉没上屏的拼音；之后要改文档的操作先等它做完
function endSession() {
  if (!session) return;
  const s = session;
  clearHumanHint(s);
  clearComposition(s);
  if (s.ime && s.ime.shown && !s.done) {
    const range = new vscode.Range(s.ime.start, s.ime.start.translate(0, s.ime.shown.length));
    if (s.editor.document.getText(range) === s.ime.shown) {
      cleanup = self(() => s.editor.edit((b) => b.delete(range), { undoStopBefore: false, undoStopAfter: false })).catch(() => {});
    }
  }
  session = null;
  refreshContexts();
  tree.refresh();
}

// ---------- 打字引擎 ----------

const OPENERS = { '(': ')', '[': ']', '{': '}' };
const CLOSERS = new Set([')', ']', '}']);
const QUOTES = new Set(['"', "'", '`']);

// 扫一遍片段，同时得到：
//   pairs：成对的括号和引号（左边下标 -> 右边下标），打左边时先补上右边、打到右边时直接越过，和编辑器一样；
//   mask：哪些字符是「代码」（不在字符串、注释里），只有打代码时才像 IDE 一样弹补全。
// 认得：行注释、/* 块注释 */（C 系语言）、Python 三引号字符串、Python f-string 和 JS 模板字符串里 {…} / ${…} 的表达式。
function scanSyntax(text, languageId) {
  const lc = lineCommentFor(languageId);
  const blockComments = lc === '//';
  const py = languageId === 'python';
  const mask = new Uint8Array(text.length);
  const pairs = new Map();
  const frames = [[]]; // 每进一个字符串开一层括号栈，字符串结束时丢弃没配上的
  const interp = []; // 正在字符串里的 {表达式} 中：外面那个字符串、表达式的左大括号
  let str = null; // 当前所在的字符串 { q, start, triple, fmt }
  const pairBracket = (i, ch) => {
    const stack = frames[frames.length - 1];
    if (OPENERS[ch]) stack.push(i);
    else if (CLOSERS.has(ch) && stack.length && OPENERS[text[stack[stack.length - 1]]] === ch) pairs.set(stack.pop(), i);
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (str) {
      if (ch === '\\') { i++; continue; }
      if (str.triple) {
        if (text.startsWith(str.q.repeat(3), i)) { i += 2; str = null; }
        continue;
      }
      if (str.fmt && ch === '{' && text[i + 1] === '{' && str.q !== '`') { i++; continue; } // f-string 里的 {{ 是普通字符
      const opensExpr = str.fmt && (str.q === '`' ? ch === '$' && text[i + 1] === '{' : ch === '{');
      if (opensExpr) {
        const brace = str.q === '`' ? i + 1 : i;
        interp.push({ str, open: brace });
        str = null;
        frames.push([brace]);
        mask[brace] = 1;
        i = brace;
        continue;
      }
      if (ch === str.q) { pairs.set(str.start, i); str = null; frames.pop(); continue; }
      if (ch === '\n' && str.q !== '`') { str = null; frames.pop(); continue; }
      pairBracket(i, ch); // 字符串里的括号只和同一个字符串里的配对
      continue;
    }
    if (ch === '}' && interp.length) {
      const top = interp[interp.length - 1];
      const stack = frames[frames.length - 1];
      if (stack.length === 1 && stack[0] === top.open) { // {表达式} 结束，回到外面的字符串里
        pairs.set(top.open, i);
        mask[i] = 1;
        frames.pop();
        str = top.str;
        interp.pop();
        continue;
      }
    }
    if (lc && text.startsWith(lc, i)) {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (blockComments && text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 1;
      continue;
    }
    if (py && (text.startsWith('"""', i) || text.startsWith("'''", i))) {
      str = { q: ch, start: i, triple: true };
      i += 2;
      continue;
    }
    if (QUOTES.has(ch)) {
      const before = text.slice(Math.max(0, i - 3), i);
      const fmt = ch === '`' || (py && /(^|[^A-Za-z0-9_])([fF][rR]?|[rR][fF])$/.test(before));
      str = { q: ch, start: i, triple: false, fmt };
      frames.push([]);
      continue;
    }
    mask[i] = 1;
    pairBracket(i, ch);
  }
  return { pairs, mask };
}

const isWordChar = (c) => !!c && /[A-Za-z0-9_]/.test(c);

function lineCommentFor(languageId) {
  if (['python', 'shellscript', 'yaml', 'ruby', 'r', 'perl', 'dockerfile', 'makefile', 'toml'].includes(languageId)) return '#';
  if (['plaintext', 'markdown', 'json'].includes(languageId)) return '';
  return '//';
}

async function beginSession(editor, snippet, resumeFrom) {
  let startPos = resumeFrom;
  let keptIndent = 0;
  const text = norm(snippet.code);
  if (!startPos) {
    const line = editor.document.lineAt(landingLine(editor.document, editor.selection.active.line, snippet));
    if (line.text.length > 0 && /^[ \t]+$/.test(line.text) && text.startsWith(line.text)) {
      keptIndent = line.text.length; // 空行里已经有正确的缩进（编辑器自动缩进留下的）：直接从缩进后面开始
    } else if (line.text.length > 0) {
      // 清掉空行里的缩进，从行首开始：片段里自带正确的缩进
      await editor.edit((b) => b.delete(line.range), { undoStopBefore: true, undoStopAfter: false });
    }
    startPos = new vscode.Position(line.lineNumber, 0);
    const at = startPos.translate(0, keptIndent);
    editor.selection = new vscode.Selection(at, at);
  }
  const syntax = scanSyntax(text, editor.document.languageId);
  session = {
    editor, snippet, text, index: 0, done: false,
    startPos, cursor: startPos,
    pairs: syntax.pairs,
    autoClosed: new Set(), // 已经提前补上的右括号/右引号（片段里的下标）
    code: syntax.mask,
    word: null, // 正在打的单词 { start, end, decided }
    suggestOpen: false,
    hintClosers: new Set(), // 打开了参数提示的函数调用，对应右括号的下标
    preNewlines: new Set(), // 已经提前打好的换行（右括号被挪到下面单独一行时），片段里的下标
    queue: Promise.resolve(), backlog: 0,
  };
  if (keptIndent) {
    session.index = keptIndent;
    session.cursor = startPos.translate(0, keptIndent);
  }
  refreshContexts();
  tree.refresh();
}

// 接着上次打了一半的地方打：已经在文件里的部分不动，从断点继续；打乱了的先清掉再从头打
async function resumePartial(editor, snippet, info) {
  const doc = editor.document;
  const got = info.prefix;
  if (!got) {
    await editor.edit((b) => b.replace(info.range, ''), { undoStopBefore: true, undoStopAfter: false });
    const at = new vscode.Position(info.range.start.line, 0);
    editor.selection = new vscode.Selection(at, at);
    await beginSession(editor, snippet);
    return;
  }
  await beginSession(editor, snippet, info.range.start);
  const s = session;
  const cursor = advancePos(info.range.start, norm(doc.getText(info.range)).slice(0, got.len));
  s.index = got.len;
  s.autoClosed = new Set(got.pending);
  s.preNewlines = new Set(got.pre || []);
  s.cursor = cursor;
  editor.selection = new vscode.Selection(cursor, cursor);
  editor.revealRange(new vscode.Range(cursor, cursor), vscode.TextEditorRevealType.Default);
  refreshContexts();
  tree.refresh();
}

// 每次按键排队处理；乱按太快时最多积压 2 次，手一停字也很快停下，不会自己继续打很久。
function step() {
  const current = session;
  if (!current || current.done || current.finishing || current.paused || current.backlog >= 2) return;
  current.backlog++;
  current.queue = current.queue
    .then(() => self(() => typeOneKey(current)))
    .catch((err) => {
      console.error('[dickBlackTune]', err && err.stack || err);
      // 出错了（比如编辑器刚被关掉）：先暂停这一段，不要卡住，点回原处再按键接着打
      if (session === current && !current.done) pauseSession();
    })
    .finally(() => { current.backlog--; });
  return current.queue;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 退格：删掉刚打的上一个字，进度退一格。换行、括号这种牵扯自动补全的位置不退（真人按了也只是删一个空白，不明显）
function stepBack() {
  const current = session;
  if (!current || current.done || current.finishing || current.paused || current.backlog >= 2) return undefined;
  current.backlog++;
  current.queue = current.queue
    .then(() => self(() => backOne(current)))
    .catch((err) => console.error('[dickBlackTune]', err && err.stack || err))
    .finally(() => { current.backlog--; });
  return current.queue;
}

async function backOne(current) {
  if (session !== current || current.done || current.paused || current.human || current.ime) return;
  if (wrongEditor(current)) return;
  const { editor, text } = current;
  const pos = current.cursor;
  if (current.typo) { // 刚好有个打错的字母：正好删掉它
    const t = current.typo;
    current.typo = null;
    await editor.edit((b) => b.delete(new vscode.Range(t.pos, t.pos.translate(0, 1))), { undoStopBefore: false, undoStopAfter: false });
    moveCursor(current, t.pos);
    return;
  }
  const i = current.index - 1;
  if (i < 0 || pos.character === 0) return;
  const ch = text[i];
  if (ch === '\n' || current.pairs.has(i) || [...current.pairs.values()].includes(i)) return;
  const prev = pos.translate(0, -1);
  if (editor.document.getText(new vscode.Range(prev, pos)) !== ch) return;
  await editor.edit((b) => b.delete(new vscode.Range(prev, pos)), { undoStopBefore: false, undoStopAfter: false });
  current.index = i;
  current.word = null;
  moveCursor(current, prev);
  await hideSuggest(current);
  updateStatus();
}

// 一次按键像真人敲一下：多数时候出 1 个字，偶尔连出 2 个；字与字的间隔随机，
// 标点后面稍停一下。按得慢字就出得慢，手一停字也跟着停。
// 演示者切到了别的文件：先暂停这一段，排队中的按键不能写进别的文件；切回来点原处再按键就接着打
function wrongEditor(current) {
  const active = vscode.window.activeTextEditor;
  if (!active || active.document !== current.editor.document) return true;
  current.editor = active; // 切走再切回来时 VS Code 会换一个新的编辑器对象，跟着换
  return false;
}

async function typeOneKey(current) {
  if (session !== current || current.done || current.finishing || current.human || current.paused) return;
  if (wrongEditor(current)) { pauseSession(); return; }
  const cfg = vscode.workspace.getConfiguration('dickBlackTune');
  const maxChars = Math.max(1, cfg.get('chunkSize', 2));
  // 手感会时快时慢：整体速度在 0.7～1.4 倍之间慢慢漂移
  current.tempo = Math.min(1.4, Math.max(0.7, (current.tempo || 0.8 + Math.random() * 0.5) + (Math.random() - 0.5) * 0.12));
  const baseDelay = Math.max(0, cfg.get('typingDelay', 35)) * current.tempo;
  // 停下来想一想：新起一行的开头最常停、停得也久；等号后面、def/func 之后次之；单词之间偶尔停一下
  const { text } = current;
  const idx = current.index;
  const lineHead = text.slice(text.lastIndexOf('\n', idx - 1) + 1, idx);
  const prevCh = text[idx - 1];
  if (baseDelay) {
    let chance = 0;
    let ms = 0;
    if (idx === 0 || /^[ \t]*$/.test(lineHead)) { chance = 0.22; ms = 400 + Math.random() * 900; }
    else if (/(=|\b(def|func|function|return|class|if|for|while))\s*$/.test(lineHead)) { chance = 0.12; ms = 300 + Math.random() * 700; }
    else if (prevCh === ' ' || prevCh === ',' || prevCh === '\t') { chance = 0.08; ms = 250 + Math.random() * 450; }
    if (Math.random() < chance) {
      await sleep(ms);
      if (session !== current || current.paused) return;
    }
  }
  const target = maxChars === 1 ? 1 : 1 + Math.floor(Math.random() * Math.random() * maxChars);
  let visible = 0;
  while (current.index < current.text.length && visible < target) {
    if (session !== current || current.paused) return;
    if (wrongEditor(current)) { pauseSession(); return; }
    if (await maybeAcceptCompletion(current)) { visible = target; break; }
    const ch = current.text[current.index];
    const shown = await typeNext(current);
    if (shown === 'human') { updateStatus(); return; }
    if (shown) visible++;
    if (visible < target && baseDelay) {
      // 要按 Shift 的符号和大写字母、数字，手指要挪远一点，慢一些
      let pause = /[,;:(){}[\]=]/.test(ch) ? 1.6 : 1;
      if (/[A-Z~!@#$%^&*()_+{}|:"<>?]/.test(ch)) pause *= 1.6 + Math.random() * 0.6;
      else if (/[0-9]/.test(ch)) pause *= 1.4;
      await sleep(baseDelay * pause * (0.4 + Math.random() * 1.5));
    }
  }
  // 空格不单独占一下按键，和它后面的那个字一起出（单词刚打完时补全列表还开着，和真人一样）
  if (session === current && current.index >= current.text.length) await finish(current);
  updateStatus();
}

// 键盘上相邻的键（打错字时用）
const NEAR_KEYS = {
  q: 'wa', w: 'qes', e: 'wrd', r: 'etf', t: 'ryg', y: 'tuh', u: 'yij', i: 'uok', o: 'ipl', p: 'ol',
  a: 'qsz', s: 'adw', d: 'sfe', f: 'dgr', g: 'fht', h: 'gjy', j: 'hku', k: 'jli', l: 'ko',
  z: 'xa', x: 'zcs', c: 'xvd', v: 'cbf', b: 'vng', n: 'bmh', m: 'nj',
};

// 打出片段里的下一个"单位"：普通字符、或 换行+下一行缩进。返回是否出现了可见字符。
async function typeNext(current) {
  const { editor, text } = current;
  const i = current.index;
  const ch = text[i];
  const pos = current.cursor;

  // 这个右括号/右引号已经提前补上了：直接越过，和编辑器里的效果一样
  if (current.autoClosed.has(i)) {
    current.autoClosed.delete(i);
    current.index = i + 1;
    moveCursor(current, pos.translate(0, 1));
    current.word = null;
    await hideSuggest(current);
    if (current.hintClosers.delete(i)) await vscode.commands.executeCommand('closeParameterHints');
    return true;
  }

  // 汉字（可选）：像用拼音输入法一样，先打出带下划线的拼音、弹出候选条，再上屏
  if (chineseMode() === 'fake' && (current.ime || isCJK(ch))) return imeStep(current);

  // 汉字：停下来，交给演示者切到中文输入法自己打
  if (chineseMode() === 'human') {
    const runEnd = humanRunEnd(text, i);
    if (runEnd) {
      const lineText = editor.document.lineAt(pos.line).text;
      current.human = {
        start: i, end: runEnd, expected: text.slice(i, runEnd), startPos: pos,
        prefix: lineText.slice(0, pos.character), suffix: lineText.slice(pos.character),
      };
      current.word = null;
      await hideSuggest(current);
      showHumanHint(current);
      refreshContexts();
      tree.refreshSoon();
      return 'human';
    }
  }

  // 字母、数字、下划线、点：真的用编辑器的打字通道敲进去，IDE 会自己弹出补全列表、跟着过滤，和真人打字完全一样
  // 刚才故意打错的那个字母：先愣一下，再像按了退格一样删掉
  if (current.typo) {
    const t = current.typo;
    current.typo = null;
    await sleep(80 + Math.random() * 200);
    if (session !== current || current.paused) return true;
    if (editor.document.getText(new vscode.Range(t.pos, t.pos.translate(0, 1))) === t.ch) {
      await editor.edit((b) => b.delete(new vscode.Range(t.pos, t.pos.translate(0, 1))), { undoStopBefore: false, undoStopAfter: false });
    }
    moveCursor(current, t.pos);
    return true;
  }
  // 偶尔打错：单词中间的小写字母，按到键盘上旁边的键，下一下再删掉
  const typoRate = vscode.workspace.getConfiguration('dickBlackTune').get('typoRate', 1);
  if (typoRate > 0 && current.code[i] && /[a-z]/.test(ch) && isWordChar(text[i - 1]) && i - (current.lastTypo || -99) > 30
    && Math.random() * 100 < typoRate && NEAR_KEYS[ch]) {
    const near = NEAR_KEYS[ch];
    const wrong = near[Math.floor(Math.random() * near.length)];
    await editor.edit((b) => b.insert(pos, wrong), { undoStopBefore: false, undoStopAfter: false });
    current.typo = { pos, ch: wrong };
    current.lastTypo = i;
    moveCursor(current, pos.translate(0, 1));
    return true;
  }

  const realType = isWordChar(ch) || (ch === '.' && current.code[i] && (isWordChar(text[i - 1]) || /[)\]]/.test(text[i - 1])));
  if (completionOn() && realType && !current.pairs.has(i) && !wrongEditor(current)) {
    if (editor.selections.length > 1 || !editor.selection.isEmpty || !editor.selection.active.isEqual(pos)) editor.selection = new vscode.Selection(pos, pos);
    // "." 在补全列表开着时会被当成"确认补全"，先把列表收起来
    if (ch === '.') await hideSuggest(current, true);
    const before = editor.document.version;
    await vscode.commands.executeCommand('default:type', { text: ch });
    if (editor.document.version === before && wrongEditor(current)) {
      // 刚好这一刻切到了别的文件，字打进了别的文件：撤回那个字，这一段暂停，切回来点原处再按键接着打
      const active = vscode.window.activeTextEditor;
      if (active && active.document.isDirty) await vscode.commands.executeCommand('deleteLeft');
      pauseSession();
      return false;
    }
    if (editor.document.lineAt(pos.line).text[pos.character] !== ch) {
      // 极少数情况下没敲进去（比如焦点不在编辑器）：改用直接插入，保证内容不出错
      const we = new vscode.WorkspaceEdit();
      we.insert(editor.document.uri, pos, ch);
      await vscode.workspace.applyEdit(we);
    }
    current.index = i + 1;
    const end = pos.translate(0, 1);
    current.cursor = end;
    if (!editor.selection.active.isEqual(end)) editor.selection = new vscode.Selection(end, end);
    editor.revealRange(new vscode.Range(end, end), vscode.TextEditorRevealType.Default);
    await afterChar(current, i, ch);
    return true;
  }

  let insert = ch;
  let next = i + 1;
  if ((ch === ' ' || ch === '\t') && (i === 0 || text[i - 1] === '\n')) {
    while (next < text.length && (text[next] === ' ' || text[next] === '\t')) next++;
    insert = text.slice(i, next);
  }
  if (ch === '\n') {
    // 换行时把下一行的缩进一起打出，相当于编辑器的自动缩进
    while (next < text.length && (text[next] === ' ' || text[next] === '\t')) next++;
    insert = text.slice(i, next);
    const doc = editor.document;
    const indent = next - i - 1;
    // 这个换行之前已经替右括号打好了（右括号早被挪到了下面那一行）：光标直接移到下一行右括号前面
    if (current.preNewlines.has(i)) {
      current.preNewlines.delete(i);
      const below = pos.line + 1 < doc.lineCount ? doc.lineAt(pos.line + 1).text : '';
      if (below.slice(0, indent) === text.slice(i + 1, next) && below[indent] === text[next]) {
        current.index = next;
        moveCursor(current, new vscode.Position(pos.line + 1, indent));
        await afterChar(current, i, ch);
        return false;
      }
    }
    // 光标后面还挂着自动补上的右括号（比如 {|} 中间回车）：像编辑器一样，右括号挪到下面单独一行，
    // 光标留在中间的新行上。只在这个右括号在原文里也独占一行开头时才这样做（如 Python 的 foo(a,\n  b) 就不挪）
    const rest = doc.lineAt(pos.line).text.slice(pos.character);
    const c0 = current.autoClosed.size ? Math.min(...current.autoClosed) : -1;
    if (rest && c0 >= 0 && rest[0] === text[c0]) {
      const n0 = text.lastIndexOf('\n', c0 - 1);
      const closerIndent = text.slice(n0 + 1, c0);
      if (n0 > i && /^[ \t]*$/.test(closerIndent)) {
        const ok = await editor.edit((b) => b.insert(pos, insert + '\n' + closerIndent), { undoStopBefore: false, undoStopAfter: false });
        if (!ok) return false;
        current.preNewlines.add(n0);
        current.index = next;
        moveCursor(current, new vscode.Position(pos.line + 1, indent));
        await afterChar(current, i, ch);
        return false;
      }
    }
  }
  let closer = '';
  if (current.pairs.has(i)) {
    const j = current.pairs.get(i);
    closer = text[j];
    current.autoClosed.add(j);
  }

  const ok = await editor.edit((b) => b.insert(pos, insert + closer), { undoStopBefore: false, undoStopAfter: false });
  if (!ok) return false;
  current.index = next;
  const parts = insert.split('\n');
  const end = parts.length === 1
    ? pos.translate(0, insert.length)
    : new vscode.Position(pos.line + parts.length - 1, parts[parts.length - 1].length);
  moveCursor(current, end);
  await afterChar(current, i, ch);
  return ch !== '\n' && ch !== ' ' && ch !== '\t';
}

// ---------- 中文：交给演示者用真的输入法打 ----------

const isCJK = (c) => !!c && /[\u3400-\u9fff\uf900-\ufaff]/.test(c);
const isFullWidth = (c) => !!c && /[\u3000-\u303f\uff00-\uffef]/.test(c);

function chineseMode() {
  return vscode.workspace.getConfiguration('dickBlackTune').get('chineseMode', 'human');
}

// 从 i 开始的一串汉字（连同挨着的全角标点）；不含汉字时返回 0（单独的全角标点由插件直接打出）
function humanRunEnd(text, i) {
  if (!isCJK(text[i]) && !isFullWidth(text[i])) return 0;
  let j = i;
  while (j < text.length && (isCJK(text[j]) || isFullWidth(text[j]))) j++;
  return /[\u3400-\u9fff\uf900-\ufaff]/.test(text.slice(i, j)) ? j : 0;
}

let hintDeco = null;
function showHumanHint(current) {
  updateHumanHint(current);
}

// 灰色提示文字：只提示还没打的那部分，跟在已经打出的字后面；输入法拼写中不显示
function updateHumanHint(current) {
  const h = current.human;
  if (!h || composing || !vscode.workspace.getConfiguration('dickBlackTune').get('chineseHint', true)) return clearHumanHint(current);
  if (!hintDeco) hintDeco = vscode.window.createTextEditorDecorationType({});
  const doc = current.editor.document;
  const sel = current.editor.selection.active;
  const lineText = doc.lineAt(h.startPos.line).text;
  const typed = sel.line === h.startPos.line && sel.character >= h.startPos.character ? lineText.slice(h.startPos.character, sel.character) : '';
  const rest = h.expected.startsWith(typed) ? h.expected.slice(typed.length) : '';
  if (!rest) return clearHumanHint(current);
  current.editor.setDecorations(hintDeco, [{
    range: new vscode.Range(sel, sel),
    renderOptions: { after: { contentText: rest, color: new vscode.ThemeColor('editorGhostText.foreground'), fontStyle: 'normal' } },
  }]);
}

function clearHumanHint(current) {
  if (hintDeco) current.editor.setDecorations(hintDeco, []);
}

// 演示者打完中文、切回英文再按键时继续；打的和预期不一样（选错字、少打）就自动纠正成正确内容
async function resumeHuman(current) {
  const h = current.human;
  if (!h) return;
  current.human = null;
  clearHumanHint(current);
  const { editor } = current;
  const doc = editor.document;
  // 不管输入法打成什么样（选错字、多出拼音、删多了），这一行都纠正成「光标前原样 + 正确中文 + 光标后原样」
  const want = h.prefix + h.expected + h.suffix;
  const line = doc.lineAt(h.startPos.line);
  if (line.text !== want) {
    await editor.edit((b) => b.replace(line.range, want), { undoStopBefore: false, undoStopAfter: false });
  }
  current.index = h.end;
  moveCursor(current, new vscode.Position(h.startPos.line, h.prefix.length + h.expected.length));
  refreshContexts();
  tree.refreshSoon();
}

// 等中文期间的按键：输入法上屏的中文、退格照常进编辑器；英文字母（说明已切回英文）、回车、Tab 表示打完了，接着往下打
async function humanKey(current, args) {
  if ((args.fallback === 'type' && args.text && /[^\x00-\x7f]/.test(args.text)) || args.fallback === 'deleteLeft' || args.fallback === 'deleteRight') {
    await passthrough(args);
    updateHumanHint(current);
    return undefined;
  }
  // 一个中文都还没打就按英文键：多半是忘了切输入法。先不动（不让中文凭空出现），连按好几下还没打才替他补上
  const h = current.human;
  const lineNow = current.editor.document.lineAt(h.startPos.line).text;
  if (lineNow === h.prefix + h.suffix && (h.idleKeys = (h.idleKeys || 0) + 1) < 6) return undefined;
  await self(() => resumeHuman(current));
  return step();
}

// ---------- 中文：模拟拼音输入法（可选）----------

let pinyinLib = null;
function toPinyin(chars) {
  if (!pinyinLib) pinyinLib = require('./lib/pinyin-pro.js');
  return pinyinLib.pinyin(chars, { toneType: 'none', type: 'array', v: true });
}

// 候选条颜色跟系统外观一致：auto 时在 macOS 上读系统的深色/浅色设置
let systemDark = null;
function imeDark() {
  const t = vscode.workspace.getConfiguration('dickBlackTune').get('imeTheme', 'auto');
  if (t !== 'auto') return t === 'dark';
  if (systemDark === null) {
    systemDark = false;
    if (process.platform === 'darwin') {
      try {
        systemDark = /dark/i.test(require('child_process').execSync('defaults read -g AppleInterfaceStyle', { timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] }).toString());
      } catch (err) { systemDark = false; }
    } else if (process.platform === 'win32') {
      // 微软拼音跟的是 Windows「应用模式」的浅色/深色，不是 VS Code 主题
      try {
        const out = require('child_process').execSync('reg query HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize /v AppsUseLightTheme',
          { timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
        systemDark = /AppsUseLightTheme\s+REG_DWORD\s+0x0\b/.test(out);
      } catch (err) { systemDark = false; }
    } else {
      systemDark = vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark || vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.HighContrast;
    }
  }
  return systemDark;
}

let compDeco = null; // 拼音下面的下划线
let candDeco = null; // 候选条
function imeDecorations() {
  if (!compDeco) {
    compDeco = vscode.window.createTextEditorDecorationType({ textDecoration: 'underline' });
    candDeco = vscode.window.createTextEditorDecorationType({ after: {} });
  }
}

// 每次按键：拼音多打一个字母；拼音打完后的下一次按键＝按空格上屏
async function imeStep(current) {
  const { editor, text } = current;
  imeDecorations();
  if (!current.ime) {
    // 一串汉字按 2～4 个字一组来打，像平时打词组一样
    let end = current.index;
    while (end < text.length && isCJK(text[end])) end++;
    const run = text.slice(current.index, end);
    const size = Math.min(run.length, 2 + Math.floor(Math.random() * 3));
    const chars = run.slice(0, run.length - size === 1 ? run.length : size);
    const sylls = toPinyin(run).slice(0, chars.length);
    current.ime = { chars, sylls, total: sylls.join('').length, typed: 0, start: current.cursor, shown: '' };
  }
  const ime = current.ime;
  const range = new vscode.Range(ime.start, ime.start.translate(0, ime.shown.length));

  if (ime.typed < ime.total) {
    ime.typed++;
    const shown = composeText(ime.sylls, ime.typed);
    await editor.edit((b) => b.replace(range, shown), { undoStopBefore: false, undoStopAfter: false });
    ime.shown = shown;
    moveCursor(current, ime.start.translate(0, shown.length));
    showComposition(current);
    return true;
  }

  // 上屏：拼音换成汉字
  await sleep(80 + Math.random() * 220);
  if (session !== current || current.paused || wrongEditor(current)) return true; // 停顿期间被暂停/结束了：先不上屏
  await editor.edit((b) => b.replace(range, ime.chars), { undoStopBefore: false, undoStopAfter: false });
  moveCursor(current, ime.start.translate(0, ime.chars.length));
  current.index += ime.chars.length;
  current.ime = null;
  clearComposition(current);
  return true;
}

// 拼音之间用 ' 分隔，和系统输入法显示的一样（如 ce'shi'ji）
function composeText(sylls, n) {
  let out = '';
  let left = n;
  for (let k = 0; k < sylls.length && left > 0; k++) {
    if (k > 0) out += "'";
    const part = sylls[k].slice(0, left);
    out += part;
    left -= part.length;
  }
  return out;
}

// 常用字、常用双字词按拼音索引（由 jieba 词频生成），像真输入法一样按常用程度排候选
let imeDict = null;
function dict() {
  if (!imeDict) {
    imeDict = require('./lib/ime-dict.json');
    imeDict.rankOf = new Map([...imeDict.r].map((c, i) => [c, i]));
  }
  return imeDict;
}

// 拼音 s 开头（可能只打了一半，如 "c"、"zh"）能出的单字，按常用程度排
function charsFor(prefix, complete) {
  const d = dict();
  if (complete && d.c[prefix]) return [...d.c[prefix]];
  const seen = new Set();
  for (const [syl, cs] of Object.entries(d.c)) if (syl.startsWith(prefix)) for (const c of cs) seen.add(c);
  const rank = (c) => (d.rankOf.has(c) ? d.rankOf.get(c) : 1e6);
  return [...seen].sort((a, b) => rank(a) - rank(b));
}

// 两个音节（第二个可能只打了一半）能出的常用词
function wordsFor(first, second, complete) {
  const d = dict();
  if (complete) return d.w[`${first} ${second}`] ? d.w[`${first} ${second}`].match(/../g) : [];
  const out = [];
  const head = `${first} ${second}`;
  for (const [k, ws] of Object.entries(d.w)) {
    if (k.startsWith(head) && k.indexOf(' ', first.length + 1) < 0) out.push(...ws.match(/../g).slice(0, 2));
    if (out.length >= 8) break;
  }
  return out;
}

function candidatesFor(ime) {
  // 已经打了哪些音节：完整的几个 + 最后一个打了一半的
  const done = [];
  let partial = '';
  let left = ime.typed;
  for (const s of ime.sylls) {
    if (left <= 0) break;
    if (left >= s.length) { done.push(s); left -= s.length; } else { partial = s.slice(0, left); left = 0; }
  }
  const covered = done.length + (partial ? 1 : 0);
  // 拼写途中按真实词频排（打出「c」时首选是「从」这类常用字）；拼音全部打完、准备按空格上屏时，要打的词排第一
  const list = ime.typed >= ime.total ? [ime.chars] : [];
  try {
    if (covered >= 2) {
      const second = partial && done.length === 1 ? partial : done[1];
      list.push(...wordsFor(done[0], second, !(partial && done.length === 1)));
      if (covered > 2) list.push(ime.chars.slice(0, 2));
    }
    const first = done.length ? done[0] : partial;
    // 常用字在前；常用字不够时补几个以这个音开头的常用词（像「准备」「准时」），生僻字放最后
    const d = dict();
    const cs = charsFor(first, done.length > 0);
    const common = cs.filter((c) => d.rankOf.has(c) && d.rankOf.get(c) < 3000);
    list.push(...common);
    if (done.length && list.length < 7) {
      list.push(...((d.f[first] || '').match(/../g) || []));
    }
    list.push(...cs.filter((c) => !common.includes(c)));
  } catch (err) {
    // 词库读不出来时退回只显示要打的字
    for (let n = covered - 1; n >= 1; n--) list.push(ime.chars.slice(0, n));
  }
  const out = [...new Set(list.filter(Boolean))].slice(0, 7);
  return out.length ? out : [ime.chars.slice(0, Math.max(1, covered))];
}

function candidateSvg(cands, dark) {
  const font = "-apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif";
  const pad = 6;
  const items = cands.map((c, i) => ({ c, i, w: 22 + c.length * 17 + 14 }));
  const width = pad * 2 + items.reduce((n, it) => n + it.w + 4, 0) + 26;
  const height = 38;
  const bg = dark ? '#2b2b2d' : '#ffffff';
  const fg = dark ? '#f2f2f2' : '#1d1d1f';
  const num = dark ? '#9a9a9e' : '#8e8e93';
  const border = dark ? '#4a4a4d' : '#d9d9dc';
  let x = pad;
  let body = '';
  for (const it of items) {
    if (it.i === 0) body += `<rect x="${x}" y="5" width="${it.w}" height="28" rx="6" fill="#3a82f7"/>`;
    body += `<text x="${x + 8}" y="24.5" font-family="${font}" font-size="13" fill="${it.i === 0 ? '#dce9ff' : num}">${it.i + 1}</text>`;
    body += `<text x="${x + 22}" y="25" font-family="${font}" font-size="16" fill="${it.i === 0 ? '#ffffff' : fg}">${it.c}</text>`;
    x += it.w + 4;
  }
  body += `<path d="M${x + 6} 16 l5 5 l5 -5" stroke="${num}" stroke-width="1.5" fill="none" stroke-linecap="round"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width + 4}" height="${height + 6}">`
    + `<defs><filter id="s" x="-10%" y="-10%" width="120%" height="140%"><feDropShadow dx="0" dy="1.5" stdDeviation="1.6" flood-opacity="${dark ? 0.5 : 0.18}"/></filter></defs>`
    + `<rect x="2" y="1" width="${width}" height="${height}" rx="9" fill="${bg}" stroke="${border}" stroke-width="0.8" filter="url(#s)"/>`
    + body + '</svg>';
  return { uri: vscode.Uri.parse('data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64')), width: width + 4, height: height + 6, svg };
}

function imeStyle() {
  const s = vscode.workspace.getConfiguration('dickBlackTune').get('imeStyle', 'auto');
  if (s !== 'auto') return s;
  return process.platform === 'darwin' ? 'mac' : 'microsoft';
}

const xmlEsc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

// 仿 Windows 10 微软拼音：一排候选（首选浅蓝底），右边是翻页箭头、表情和展开按钮；半透明毛玻璃底
function microsoftCandidateSvg(cands, dark, comp) {
  const font = "'Microsoft YaHei UI', 'Microsoft YaHei', -apple-system, 'PingFang SC', sans-serif";
  // Win10 微软拼音的候选窗：直角、半透明，模糊由外面的 CSS backdrop-filter 完成
  const c = dark
    ? { bg: 'rgb(40,40,40)', bgA: 0.78, border: 'rgba(255,255,255,0.12)', num: '#a6a6a6', text: '#f0f0f0', hl: 'rgba(76,140,200,0.55)', hlText: '#ffffff', icon: '#bdbdbd', sep: 'rgba(255,255,255,0.14)' }
    : { bg: 'rgb(243,243,243)', bgA: 0.8, border: 'rgba(0,0,0,0.10)', num: '#5f5f5f', text: '#1b1b1b', hl: 'rgba(150,200,240,0.75)', hlText: '#1b1b1b', icon: '#4d4d4d', sep: 'rgba(0,0,0,0.12)' };
  // 微软拼音的候选窗只有一排候选，拼音直接显示在编辑器里（带下划线），窗口里不再重复
  const topH = 0;
  const rowH = 38;
  const cjkW = 16.5;
  const items = cands.map((t, i) => ({ t, i, w: 12 + 9 + 7 + [...t].length * cjkW + 12 }));
  const listW = items.reduce((n, it) => n + it.w, 0);
  const tailW = 28 + 28 + 1 + 40 + 1 + 34;
  const width = Math.round(listW + tailW + 4);
  const height = topH + rowH;
  let x = 2;
  let body = `<rect x="0" y="0" width="${width}" height="${rowH}" fill="${c.bg}" fill-opacity="${c.bgA}"/>`;
  for (const it of items) {
    if (it.i === 0) body += `<rect x="${x}" y="${topH + 1}" width="${it.w}" height="${rowH - 3}" fill="${c.hl}"/>`;
    body += `<text x="${x + 12}" y="${topH + 24}" font-family="${font}" font-size="15" fill="${c.num}">${it.i + 1}</text>`;
    body += `<text x="${x + 12 + 9 + 7}" y="${topH + 25}" font-family="${font}" font-size="16" fill="${it.i === 0 ? c.hlText : c.text}">${xmlEsc(it.t)}</text>`;
    x += it.w;
  }
  const mid = topH + rowH / 2 - 1;
  // 翻页箭头（第一页时左箭头是灰的）
  body += `<path d="M${x + 16} ${mid - 6} l-6 6 l6 6" stroke="${c.sep}" stroke-width="1.4" fill="none"/>`;
  x += 28;
  body += `<path d="M${x + 11} ${mid - 6} l6 6 l-6 6" stroke="${c.icon}" stroke-width="1.4" fill="none"/>`;
  x += 28;
  body += `<rect x="${x}" y="${topH + 4}" width="1" height="${rowH - 10}" fill="${c.sep}"/>`;
  x += 1;
  // 表情按钮
  const ex = x + 20;
  body += `<circle cx="${ex}" cy="${mid}" r="8.5" stroke="${c.icon}" stroke-width="1.3" fill="none"/>`
    + `<circle cx="${ex - 3}" cy="${mid - 2.5}" r="1.1" fill="${c.icon}"/><circle cx="${ex + 3}" cy="${mid - 2.5}" r="1.1" fill="${c.icon}"/>`
    + `<path d="M${ex - 4} ${mid + 2} q4 4 8 0" stroke="${c.icon}" stroke-width="1.3" fill="none" stroke-linecap="round"/>`;
  x += 40;
  body += `<rect x="${x}" y="${topH + 4}" width="1" height="${rowH - 10}" fill="${c.sep}"/>`;
  x += 1;
  // 展开按钮
  body += `<path d="M${x + 12} ${mid - 3} h10 l-5 6 z" fill="${dark ? '#e6e6e6' : '#1b1b1b'}"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`
    + body
    + `<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" fill="none" stroke="${c.border}"/>`
    + '</svg>';
  return {
    uri: vscode.Uri.parse('data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64')), width, height, svg,
    // 毛玻璃：把候选窗后面的代码模糊掉
    css: `border-radius: 0; backdrop-filter: blur(14px) saturate(1.3); -webkit-backdrop-filter: blur(14px) saturate(1.3); box-shadow: 0 2px 8px rgba(0,0,0,${dark ? 0.4 : 0.18});`,
  };
}

// ---------- 候选条不跟着 VS Code 缩放变大变小（系统输入法本来就不受影响）----------

let webviewDpr = 0; // 面板报上来的 devicePixelRatio = 屏幕缩放 × VS Code 缩放

function vscodeZoomFactor() {
  const win = vscode.workspace.getConfiguration('window');
  const level = Number(win.get('zoomLevel', 0)) || 0;
  if (!webviewDpr) return Math.pow(1.2, level);
  // 把 dpr 拆成「屏幕缩放 × 1.2^缩放级别」：屏幕缩放取常见值，缩放级别取整数或设置里的值，误差最小的那组
  const screens = [1, 2, 1.25, 1.5, 1.75, 2.25, 2.5, 3];
  const levels = [level];
  for (let l = -8; l <= 9; l++) levels.push(l);
  let best = null;
  for (const lv of levels) {
    for (let i = 0; i < screens.length; i++) {
      const err = Math.abs(screens[i] * Math.pow(1.2, lv) - webviewDpr);
      const score = err + Math.abs(lv) * 0.002 + i * 0.001 + (lv === level ? -0.003 : 0);
      if (err < 0.02 && (!best || score < best.score)) best = { score, lv };
    }
  }
  return Math.pow(1.2, best ? best.lv : level);
}

// 这一行离编辑器可视区底部不到 4 行：候选条画到上方
function nearBottom(editor, pos) {
  const vr = editor.visibleRanges;
  if (!vr || !vr.length) return false;
  return pos.line >= vr[vr.length - 1].end.line - 3;
}

function unzoom(built) {
  const z = vscodeZoomFactor();
  if (!built.svg || Math.abs(z - 1) < 0.001) return built;
  const w = +(built.width / z).toFixed(2);
  const h = +(built.height / z).toFixed(2);
  const svg = built.svg.replace(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="([\d.]+)" height="([\d.]+)">/,
    (m, sw, sh) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${sw} ${sh}">`);
  return Object.assign({}, built, { svg, width: w, height: h, uri: vscode.Uri.parse('data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64')) });
}

function showComposition(current) {
  const { editor, ime } = current;
  const end = ime.start.translate(0, ime.shown.length);
  editor.setDecorations(compDeco, [new vscode.Range(ime.start, end)]);
  const dark = imeDark();
  const cands = candidatesFor(ime);
  const svg = unzoom(imeStyle() === 'microsoft' ? microsoftCandidateSvg(cands, dark, ime.shown) : candidateSvg(cands, dark));
  // 候选条画在拼音正下方，浮在代码上面
  editor.setDecorations(candDeco, [{
    range: new vscode.Range(end, end),
    renderOptions: {
      after: {
        contentIconPath: svg.uri,
        width: `${svg.width}px`,
        height: `${svg.height}px`,
        textDecoration: `none; position: absolute; top: ${nearBottom(editor, end) ? `calc(-${svg.height}px - 0.35em)` : '1.25em'}; margin-left: -${ime.shown.length}ch; z-index: 100; pointer-events: none; ${svg.css || ''}`,
      },
    },
  }]);
}

function clearComposition(current) {
  if (!compDeco) return;
  current.editor.setDecorations(compDeco, []);
  current.editor.setDecorations(candDeco, []);
}

function completionOn() {
  return vscode.workspace.getConfiguration('dickBlackTune').get('completion', true);
}

// 像 IDE 一样：开始打一个单词、或者打了"."时弹出补全列表；打到符号时收起；
// 打"函数名("时弹出参数提示，打到对应的")"时收起。弹出的都是编辑器自己的真实内容。
async function afterChar(current, i, ch) {
  if (!completionOn()) return;
  const { text, code } = current;
  const prev = text[i - 1];
  if (code[i] && isWordChar(ch) && /[A-Za-z_]/.test(ch) && !isWordChar(prev)) {
    let end = i;
    while (end < text.length && isWordChar(text[end])) end++;
    current.word = { start: i, end, decided: false };
    current.suggestOpen = true; // 真打字时编辑器会自己弹出补全
    return;
  }
  if (isWordChar(ch) && current.word) return;
  current.word = null;
  if (code[i] && ch === '.' && isWordChar(prev)) {
    current.suggestOpen = true; // "." 是触发字符，编辑器会自己弹出成员列表
    return;
  }
  await hideSuggest(current);
  if (code[i] && ch === ',' && current.hintClosers.size) await vscode.commands.executeCommand('editor.action.triggerParameterHints');
  if (code[i] && ch === '(' && isWordChar(prev) && current.pairs.has(i)) {
    current.hintClosers.add(current.pairs.get(i));
    await vscode.commands.executeCommand('editor.action.triggerParameterHints');
  }
}

async function hideSuggest(current, force) {
  if (!current.suggestOpen && !force) return;
  current.suggestOpen = false;
  await vscode.commands.executeCommand('hideSuggestWidget');
}

// 长单词打了几个字母后，有时像按 Tab 接受补全一样，剩下的部分一下子出来
async function maybeAcceptCompletion(current) {
  const w = current.word;
  if (!completionOn() || !w || w.decided || !current.suggestOpen || current.typo) return false;
  const typedLen = current.index - w.start;
  if (typedLen < 3 || w.end - w.start < 7 || w.end - current.index < 3) return false;
  w.decided = true;
  const ccfg = vscode.workspace.getConfiguration('dickBlackTune');
  if (Math.random() * 100 >= ccfg.get('completionChance', 40)) return false;
  const word = current.text.slice(w.start, w.end);
  if (isDefinition(current, w)) return false; // 正在起名字（def xxx、xxx :=）：真实编辑器里列表里不会有它
  // 像人一样：先看一眼补全列表，停顿一下再按 Tab 选中；同时查一下列表里排第一的是不是这个词
  const pause = Math.max(0, ccfg.get('completionPause', 300));
  const top = topCompletion(current, word.slice(0, typedLen));
  await sleep(pause * (0.67 + Math.random() * 0.66)); // 补全列表弹出后，像人一样看一眼再按 Tab
  if (session !== current || current.paused || wrongEditor(current)) return true; // 停顿期间被暂停/结束了：这次不补
  const first = await Promise.race([top, sleep(250).then(() => null)]);
  if (first !== word) return false; // 列表里排第一的不是它（或者根本没有）：老老实实接着打
  const rest = current.text.slice(current.index, w.end);
  const pos = current.cursor;
  const ok = await current.editor.edit((b) => b.insert(pos, rest), { undoStopBefore: false, undoStopAfter: false });
  if (!ok) return false;
  current.index = w.end;
  moveCursor(current, pos.translate(0, rest.length));
  current.word = null;
  await hideSuggest(current);
  await sleep(pause * (0.2 + Math.random() * 0.25)); // 选中后稍停再继续打
  return true;
}

// 这个词是不是正在被定义（真实编辑器的补全列表里不会出现还没写出来的新名字）
function isDefinition(current, w) {
  const { text } = current;
  const lineStart = text.lastIndexOf('\n', w.start - 1) + 1;
  let lineEnd = text.indexOf('\n', w.end);
  if (lineEnd < 0) lineEnd = text.length;
  const before = text.slice(lineStart, w.start);
  const after = text.slice(w.end, lineEnd);
  if (/\b(def|func|function|class|var|let|const|type|struct|interface|import|package|from|as)\s+$/.test(before)) return true;
  if (/^\s*:=/.test(after)) return true;
  if (/^\s*=(?!=)/.test(after) && /^\s*([A-Za-z_][\w]*\s*,\s*)*$/.test(before)) return true;
  return false;
}

// 补全列表此刻排第一的词：先问语言插件（和真的补全列表同一来源）；没有语言插件时按编辑器的
// 「文档里出现过的单词」补全来算，只有文件里别处出现过的词才会在列表里
async function topCompletion(current, prefix) {
  const low = prefix.toLowerCase();
  const pick = (labels) => {
    const c = [...new Set(labels.filter((l) => l && l.toLowerCase().startsWith(low)))];
    c.sort((a, b) => (a.toLowerCase() === low ? -1 : 0) - (b.toLowerCase() === low ? -1 : 0) || a.localeCompare(b));
    return c[0] || null;
  };
  try {
    const doc = current.editor.document;
    const list = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', doc.uri, current.cursor);
    const items = (list && list.items) || [];
    if (items.length) {
      const sorted = items.slice().sort((a, b) => String(a.sortText || labelOf(a)).localeCompare(String(b.sortText || labelOf(b))));
      return pick(sorted.map(labelOf).map((l) => l.replace(/\(.*$/, '')));
    }
    // 没有任何语言插件：文档里别处出现过的单词（不算正在打的这个）
    const cur = current.cursor;
    const words = [];
    for (let l = 0; l < doc.lineCount; l++) {
      const t = doc.lineAt(l).text;
      for (const m of t.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
        if (l === cur.line && m.index <= cur.character && m.index + m[0].length >= cur.character) continue;
        words.push(m[0]);
      }
    }
    return pick(words);
  } catch (err) {
    return null;
  }
}

function labelOf(item) {
  return typeof item.label === 'string' ? item.label : (item.label && item.label.label) || '';
}

// 插入位置由插件自己记着，中途光标被方向键或鼠标挪走也不会打错地方
function moveCursor(current, pos) {
  current.cursor = pos;
  current.editor.selection = new vscode.Selection(pos, pos);
  current.editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.Default);
}

async function finish(current) {
  if (current.finishing) return;
  current.finishing = true;
  clearHumanHint(current);
  clearComposition(current);
  await hideSuggest(current);
  if (current.hintClosers.size) await vscode.commands.executeCommand('closeParameterHints');
  const { editor, text, startPos } = current;
  const doc = editor.document;

  // 兜底校验：这一段占的几行必须和片段一字不差（整行比较，光标后面多出来的字也算），不一致就直接替换成片段原文
  const lastLine = Math.min(doc.lineCount - 1, current.cursor.line);
  const range = new vscode.Range(startPos.line, 0, lastLine, doc.lineAt(lastLine).text.length);
  if (norm(doc.getText(range)) !== text) {
    await editor.edit((b) => b.replace(range, text), { undoStopBefore: false, undoStopAfter: false });
    const parts = text.split('\n');
    moveCursor(current, new vscode.Position(startPos.line + parts.length - 1, parts[parts.length - 1].length));
  }

  typed.add(current.snippet.id);
  current.done = true; // 收尾全部做完才算打完：之后按键会被吞掉，点别处才进入下一段
  refreshContexts();
  tree.refresh();
}

// 底栏状态：· 演示模式已开启；正在打时只显示进度数字
// 所有操作结果都不在状态栏弹文字（投屏太显眼），只让右下角「行、列」旁边的小图标闪一下，约 1 秒后恢复；
// 具体说明放在鼠标悬停提示里。开关：✓ / ⊘，录制 ●，重置 ↺，填回 ✓✓，保存 💾，恢复原文件 ⟲，删除 🗑
let flashTimer = null;
function statusHidden() {
  return vscode.workspace.getConfiguration('dickBlackTune').get('statusBar', 'show') === 'hide';
}

function notify(icon, message) {
  if (statusHidden()) return;
  clearTimeout(flashTimer);
  statusItem.text = icon;
  statusItem.tooltip = `迪克的黑调：${message}`;
  statusItem.show();
  flashTimer = setTimeout(() => { flashTimer = null; updateStatus(); }, 1100);
}

function flashToggle(on) {
  notify(on ? '$(check)' : '$(circle-slash)', on ? '演示模式已开启' : '演示模式已关闭');
}

function updateStatus() {
  if (statusHidden()) return statusItem.hide(); // 台上完全不显示，进度只在面板里看
  if (flashTimer && !session) return; // 正在闪开关提示，等它闪完
  if (!armed) return statusItem.hide();
  if (session) {
    // 底栏只显示进度数字，挨着「行、列」，投屏时不显眼
    const pct = session.done ? 100 : Math.round((session.index / session.text.length) * 100);
    statusItem.text = session.paused ? `$(debug-pause) ${pct}%` : `${pct}%`;
    statusItem.tooltip = session.paused
      ? `迪克的黑调：「${session.snippet.name}」已暂停，光标在原处时再按键继续`
      : session.human
      ? `迪克的黑调：等你用输入法打「${session.human.expected}」，打完切回英文继续按键`
      : session.done
        ? `迪克的黑调：「${session.snippet.name}」已打完，点下一个空行继续`
        : `迪克的黑调：正在打「${session.snippet.name}」`;
  } else {
    statusItem.text = '$(circle-small-filled)';
    statusItem.tooltip = '迪克的黑调：演示模式已开启（在侧边栏面板里关闭）';
  }
  statusItem.show();
}

// ---------- 台上隐藏痕迹 ----------
// 挖空后的文件和 Git 里的版本不一样：行号旁有红色删除三角、文件名带 M，打完这些标记又全消失，像是代码本来就在。
// 一键在这个工作区里关掉 Git 改动标记，并在资源管理器里隐藏 .dick-black-tune；再点一次恢复原来的设置
const TRACE_KEY = 'dickBlackTune.hiddenTraces';

function tracesHidden() {
  return !!ctx.workspaceState.get(TRACE_KEY);
}

async function toggleTraces() {
  const ws = vscode.ConfigurationTarget.Workspace;
  if (!vscode.workspace.workspaceFolders || !vscode.workspace.workspaceFolders.length) {
    vscode.window.showErrorMessage('先用「文件 → 打开文件夹」打开演示用的工作区，才能在这个工作区里隐藏痕迹。');
    return;
  }
  const scm = vscode.workspace.getConfiguration('scm');
  const git = vscode.workspace.getConfiguration('git');
  const files = vscode.workspace.getConfiguration('files');
  if (!tracesHidden()) {
    const prev = {
      diff: scm.inspect('diffDecorations').workspaceValue,
      deco: git.inspect('decorations.enabled').workspaceValue,
      exclude: files.inspect('exclude').workspaceValue,
    };
    await scm.update('diffDecorations', 'none', ws);
    await git.update('decorations.enabled', false, ws);
    await files.update('exclude', Object.assign({}, prev.exclude || {}, { '.dick-black-tune': true, '.demo-typer': true }), ws);
    await ctx.workspaceState.update(TRACE_KEY, prev);
    notify('$(eye-closed)', '已隐藏 Git 改动标记和 .dick-black-tune 目录');
  } else {
    const prev = ctx.workspaceState.get(TRACE_KEY) || {};
    await scm.update('diffDecorations', prev.diff, ws);
    await git.update('decorations.enabled', prev.deco, ws);
    await files.update('exclude', prev.exclude, ws);
    await ctx.workspaceState.update(TRACE_KEY, undefined);
    notify('$(eye)', '已恢复 Git 改动标记和 .dick-black-tune 目录的显示');
  }
}

// 当前文件在 Git 里有没提交的改动（挖空后没提交）：面板上提醒一下
function gitDirty(doc) {
  try {
    const ext = vscode.extensions.getExtension('vscode.git');
    if (!ext || !ext.isActive) return false;
    const api = ext.exports.getAPI(1);
    const p = doc.uri.fsPath;
    return api.repositories.some((r) => [...r.state.workingTreeChanges, ...r.state.indexChanges].some((c) => c.uri.fsPath === p));
  } catch (err) {
    return false;
  }
}

// ---------- 快捷键：面板里列出来，点「修改」直接打开 VS Code 的快捷键设置 ----------

const KEY_COMMANDS = [
  ['dickBlackTune.toggleDemo', '开关演示模式'],
  ['dickBlackTune.escape', '暂停正在打的这一段'],
  ['dickBlackTune.record', '录制选中代码'],
  ['dickBlackTune.reset', '重置'],
  ['dickBlackTune.restore', '全部填回'],
  ['dickBlackTune.restoreOriginal', '恢复原文件'],
  ['dickBlackTune.deleteAll', '删除全部片段'],
];

function userKeybindingsFile() {
  try {
    // globalStorage 在 <User>/globalStorage/<插件> 下，keybindings.json 在 <User> 下
    return path.join(ctx.globalStorageUri.fsPath, '..', '..', 'keybindings.json');
  } catch (err) {
    return null;
  }
}

// keybindings.json 允许注释和结尾逗号
function parseJsonc(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2);
      if (i < 0) break;
      i++;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[\]}])/g, '$1'));
}

let kbCache = { mtime: -1, list: [] };
function userKeybindings() {
  const file = userKeybindingsFile();
  try {
    const st = fs.statSync(file);
    if (st.mtimeMs !== kbCache.mtime) {
      const list = parseJsonc(fs.readFileSync(file, 'utf8'));
      kbCache = { mtime: st.mtimeMs, list: Array.isArray(list) ? list : [] };
    }
  } catch (err) {
    if (!file || !fs.existsSync(file)) kbCache = { mtime: -1, list: [] };
  }
  return kbCache.list;
}

function prettyKey(key) {
  const mac = process.platform === 'darwin';
  const names = mac
    ? { cmd: '⌘', ctrl: '⌃', alt: '⌥', shift: '⇧', meta: '⌘', escape: 'Esc', enter: '↵', backspace: '⌫', tab: '⇥', space: '空格' }
    : { cmd: 'Win', ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', meta: 'Win', escape: 'Esc', enter: 'Enter', backspace: 'Backspace', tab: 'Tab', space: 'Space' };
  return key.trim().split(/\s+/).map((chord) => chord.split('+').map((k) => {
    const n = names[k.toLowerCase()];
    if (n) return n;
    return k.length === 1 ? k.toUpperCase() : k[0].toUpperCase() + k.slice(1);
  }).join(mac ? '' : '+')).join(' ');
}

// 每个命令当前生效的快捷键：插件默认的，加上用户自己加的，去掉用户删掉的
function keybindingList() {
  const platformKey = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux';
  const defaults = ((ctx.extension && ctx.extension.packageJSON.contributes) || {}).keybindings || [];
  const user = userKeybindings();
  return KEY_COMMANDS.map(([command, title]) => {
    let keys = defaults.filter((b) => b.command === command).map((b) => b[platformKey] || b.key).filter(Boolean);
    for (const b of user) {
      if (!b || typeof b.key !== 'string') continue;
      if (b.command === '-' + command) keys = keys.filter((k) => k !== b.key);
      else if (b.command === command && !keys.includes(b.key)) keys.push(b.key);
    }
    return { command, title, keys: keys.map(prettyKey) };
  });
}

// ---------- 侧边栏面板（所有操作都能在这里点） ----------

class PanelProvider {
  constructor(extensionUri) {
    this.extensionUri = extensionUri;
    this.view = null;
    this.timer = null;
  }

  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    const html = fs.readFileSync(path.join(this.extensionUri.fsPath, 'media', 'panel.html'), 'utf8');
    view.webview.html = html.replace(/\{\{nonce\}\}/g, nonce).replace(/\{\{csp\}\}/g, view.webview.cspSource);
    view.webview.onDidReceiveMessage((msg) => this.handle(msg).catch((err) => vscode.window.showErrorMessage(`迪克的黑调：${err.message}`)));
    view.onDidChangeVisibility(() => this.refresh());
  }

  refresh() {
    if (this.view && this.view.visible) this.view.webview.postMessage({ type: 'state', state: panelState() });
  }

  // 打字、移动光标时状态变化很频繁，合并成一次刷新
  refreshSoon() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.refresh(), 150);
  }

  async handle(msg) {
    const editor = vscode.window.activeTextEditor;
    switch (msg.type) {
      case 'ready': break;
      case 'zoom': webviewDpr = Number(msg.dpr) || 0; return;
      case 'toggleDemo': setArmed(!armed); break;
      case 'record': await recordSelection(); break;
      case 'reset': await resetDocument(); break;
      case 'restore': await restoreDocument(); break;
      case 'openManifest': await openManifest(); break;
      case 'editKey': await vscode.commands.executeCommand('workbench.action.openGlobalKeybindings', msg.command); break;
      case 'toggleTraces': await toggleTraces(); break;
      case 'openFile': await openTarget(msg.target); break;
      case 'reveal': await revealSnippet(findSnippet(msg.id)); break;
      case 'fill': await fillOne(findSnippet(msg.id)); break;
      case 'clear': await clearOne(findSnippet(msg.id)); break;
      case 'rename': editSnippet(msg.id, (s) => { s.name = String(msg.name || '').trim() || s.name; }); break;
      case 'saveCode': await saveCode(msg.id, String(msg.code || '')); break;
      case 'move': moveSnippet(msg.id, msg.dir); break;
      case 'remove': await removeSnippet(msg.id); break;
      case 'restoreOriginal': await restoreOriginal(); break;
      case 'deleteAll': await deleteAll(msg.choice); break;
      case 'setting': await updateSetting(msg.key, Number(msg.value)); break;
      case 'settingText': await updateSetting(msg.key, String(msg.value)); break;
      case 'settingBool': await updateSetting(msg.key, !!msg.value); break;
      default: break;
    }
    if (editor && msg.type !== 'ready') refreshContexts();
    this.refresh();
  }
}

// 刚装好新版本、窗口还没重新加载时，VS Code 还不认识新加的设置项，写入会失败：提示重新加载窗口
async function updateSetting(key, value) {
  try {
    await vscode.workspace.getConfiguration('dickBlackTune').update(key, value, vscode.ConfigurationTarget.Global);
  } catch (err) {
    const pick = await vscode.window.showWarningMessage('迪克的黑调刚更新过，需要重新加载窗口后才能改这个设置。', '重新加载窗口');
    if (pick) await vscode.commands.executeCommand('workbench.action.reloadWindow');
  }
}

function currentRoot() {
  const editor = vscode.window.activeTextEditor;
  return rootFor(editor && editor.document.uri);
}

function findSnippet(id) {
  return loadManifest(currentRoot()).snippets.find((s) => s.id === id);
}

function editSnippet(id, fn) {
  const root = currentRoot();
  const data = loadManifest(root);
  const s = data.snippets.find((x) => x.id === id);
  if (!s) return null;
  fn(s, data);
  saveManifest(root, data);
  return s;
}

// 改代码时，如果这段代码已经在文件里，一起改掉，保证文件和配置一致
async function saveCode(id, code) {
  const newCode = norm(code).replace(/\n+$/, '');
  if (!newCode.trim()) {
    vscode.window.showErrorMessage('代码不能为空。');
    return;
  }
  const old = findSnippet(id);
  if (!old) return;
  const editor = vscode.window.activeTextEditor;
  if (editor && snippetsFor(editor.document).some((s) => s.id === id)) {
    const doc = editor.document;
    const docText = norm(doc.getText());
    const at = findCode(docText, old.code);
    if (at >= 0) {
      await editor.edit((b) => b.replace(new vscode.Range(normPos(docText, at), normPos(docText, at + old.code.length)), newCode));
      await saveDoc(doc);
    }
  }
  editSnippet(id, (s) => { s.code = newCode; });
  notify('$(save)', `已保存「${old.name}」的代码`);
}

function moveSnippet(id, dir) {
  const root = currentRoot();
  const data = loadManifest(root);
  const list = data.snippets;
  const i = list.findIndex((s) => s.id === id);
  if (i < 0) return;
  // 只在同一个文件的片段之间换位置
  let j = i + (dir < 0 ? -1 : 1);
  while (j >= 0 && j < list.length && list[j].target !== list[i].target) j += dir < 0 ? -1 : 1;
  if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  saveManifest(root, data);
}

async function removeSnippet(id) {
  const s = findSnippet(id);
  if (!s) return;
  const editor = vscode.window.activeTextEditor;
  const inDoc = editor && snippetsFor(editor.document).some((x) => x.id === id);
  const fillBack = inDoc && findCode(norm(editor.document.getText()), s.code) < 0 && bestBlankLine(editor.document, s) >= 0;
  const choice = await vscode.window.showWarningMessage(
    `删除片段「${s.name}」？`,
    { modal: true, detail: fillBack ? '删除后这段代码就不会再由迪克的黑调打出。可以先把代码填回文件里再删除。' : '删除后这段代码就不会再由迪克的黑调打出。' },
    ...(fillBack ? ['填回文件并删除', '只删除片段'] : ['删除']),
  );
  if (!choice) return;
  if (choice === '填回文件并删除') await fillOne(s);
  const root = currentRoot();
  const data = loadManifest(root);
  data.snippets = data.snippets.filter((x) => x.id !== id);
  saveManifest(root, data);
  typed.delete(id);
}

// 单独把某一段填回文件 / 从文件里清掉
async function fillOne(s) {
  const editor = vscode.window.activeTextEditor;
  if (!s || !editor) return;
  const doc = editor.document;
  if (findCode(norm(doc.getText()), s.code) >= 0) return;
  const half = partialRange(doc, s);
  const line = half ? -1 : bestBlankLine(doc, s);
  if (!half && line < 0) {
    vscode.window.showErrorMessage(`在当前文件里找不到「${s.name}」该放的空行。`);
    return;
  }
  await editor.edit((b) => b.replace(half || doc.lineAt(line).range, s.code));
  await saveDoc(doc);
}

async function clearOne(s) {
  const editor = vscode.window.activeTextEditor;
  if (!s || !editor) return;
  if (session && session.snippet.id === s.id) endSession();
  const doc = editor.document;
  const docText = norm(doc.getText());
  const at = findCode(docText, s.code);
  const range = at >= 0 ? new vscode.Range(normPos(docText, at), normPos(docText, at + s.code.length)) : partialRange(doc, s);
  if (!range) return;
  await editor.edit((b) => b.replace(range, ''));
  await saveDoc(doc);
  typed.delete(s.id);
}

// 一键恢复：回到第一次录制之前的原文件（一字不差）；没有备份时把所有片段填回去
async function restoreOriginal() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return false;
  if (session) endSession();
  const doc = editor.document;
  const root = rootFor(doc.uri);
  const backup = backupPath(root, relTarget(root, doc));
  for (const s of snippetsFor(doc)) typed.delete(s.id);
  if (fs.existsSync(backup)) {
    const original = fs.readFileSync(backup, 'utf8');
    const all = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
    await editor.edit((b) => b.replace(all, original));
    await saveDoc(doc);
    notify('$(history)', '已恢复成录制前的原文件');
    return true;
  }
  await restoreDocument();
  notify('$(history)', '没有录制前的备份，已把所有片段填回文件');
  return true;
}

// 一键删除这个文件的所有片段；可以选择先恢复原文件
async function deleteAll(presetChoice) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const doc = editor.document;
  const mine = snippetsFor(doc);
  if (!mine.length) return;
  const choice = presetChoice || await vscode.window.showWarningMessage(
    `删除「${path.basename(doc.fileName)}」的全部 ${mine.length} 段片段？`,
    { modal: true, detail: '「恢复原文件并删除」会先把文件恢复成录制前的样子，再删掉所有片段；「只删除片段」保留文件现在的样子。' },
    '恢复原文件并删除',
    '只删除片段',
  );
  if (!choice) return;
  if (choice === '恢复原文件并删除') await restoreOriginal();
  const root = rootFor(doc.uri);
  const ids = new Set(mine.map((s) => s.id));
  const data = loadManifest(root);
  data.snippets = data.snippets.filter((s) => !ids.has(s.id));
  saveManifest(root, data);
  ids.forEach((id) => typed.delete(id));
  const backup = backupPath(root, relTarget(root, doc));
  if (fs.existsSync(backup)) fs.unlinkSync(backup);
  notify('$(trash)', `已删除 ${mine.length} 段片段`);
}

async function openTarget(target) {
  const file = path.join(currentRoot(), target || '');
  if (!target || !fs.existsSync(file)) {
    vscode.window.showErrorMessage(`找不到文件：${file}`);
    return;
  }
  await vscode.window.showTextDocument(vscode.Uri.file(file));
}

function panelState() {
  const editor = vscode.window.activeTextEditor;
  const doc = editor && editor.document;
  const fileOk = !!doc && doc.uri.scheme === 'file' && path.basename(doc.fileName) !== MANIFEST_FILE;
  const root = rootFor(doc && doc.uri);
  const data = loadManifest(root);
  const rel = fileOk ? relTarget(root, doc) : '';
  const text = fileOk ? norm(doc.getText()) : '';
  const mine = fileOk ? snippetsFor(doc) : [];
  const mineIds = new Set(mine.map((s) => s.id));
  const items = mine.map((s) => {
    let status = findCode(text, s.code) >= 0 ? 'present' : 'empty';
    if (status === 'empty' && partialRange(doc, s)) status = 'partial';
    if (session && session.snippet.id === s.id && !session.done) status = 'typing';
    return {
      id: s.id,
      name: s.name,
      code: s.code,
      lines: s.code.split('\n').length,
      anchor: (s.before || [])[0] || '文件开头',
      status,
      typedNow: typed.has(s.id),
    };
  });
  const others = {};
  for (const s of data.snippets) {
    if (mineIds.has(s.id)) continue;
    others[s.target] = (others[s.target] || 0) + 1;
  }
  const cfg = vscode.workspace.getConfiguration('dickBlackTune');
  const sels = editor ? editor.selections.filter((s) => !s.isEmpty) : [];
  return {
    armed,
    workspace: root ? path.basename(root) : '',
    file: fileOk ? { name: path.basename(doc.fileName), rel, hasBackup: fs.existsSync(backupPath(root, rel)) } : null,
    selectionLines: sels.reduce((n, s) => n + s.end.line - s.start.line + (s.end.character > 0 ? 1 : 0), 0),
    selectionCount: sels.length,
    items,
    others: Object.entries(others).map(([target, count]) => ({ target, count })),
    session: session ? {
      name: session.snippet.name,
      pct: Math.round((session.index / session.text.length) * 100),
      done: session.done,
      waitingChinese: session.human ? session.human.expected : '',
      paused: !!session.paused,
    } : null,
    settings: {
      chunkSize: cfg.get('chunkSize', 2),
      typingDelay: cfg.get('typingDelay', 35),
      completion: cfg.get('completion', true),
      chineseMode: cfg.get('chineseMode', 'human'),
      chineseHint: cfg.get('chineseHint', true),
      imeTheme: cfg.get('imeTheme', 'auto'),
      imeStyle: cfg.get('imeStyle', 'auto'),
      completionPause: cfg.get('completionPause', 300),
      completionChance: cfg.get('completionChance', 40),
      typoRate: cfg.get('typoRate', 1),
      statusBar: cfg.get('statusBar', 'show'),
    },
    tracesHidden: tracesHidden(),
    gitDirty: fileOk && mine.length > 0 && !tracesHidden() && gitDirty(doc),
    isMac: process.platform === 'darwin',
    keys: keybindingList(),
  };
}

module.exports = { activate, deactivate, scanSyntax };
