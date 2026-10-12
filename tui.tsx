// Diff in the sidebar, and in a resizable side panel.
//
// The session sidebar is a fixed 42 columns wide, so it shows a compact
// unified diff in the style of OpenCode's web/share view: one block per file,
// the directory dimmed and the filename emphasised, "+N -M" counts, no line
// numbers, and whole-line added/removed backgrounds.
//
// For a wider view, click the "Changes" header (or run /diff-panel) to open the
// same diff in the session panel: the same right-hand pane, but resizable by
// dragging the divider and togglable to full screen with `f`.
//
// Click a file's header to collapse or expand it; `c` in the panel collapses or
// expands them all. Collapsed files are remembered for the session.
//
// Sources, cycled by the palette command /sidebar-diff: the working tree
// (uncommitted edits, the default) and the session's last turn.
//
// Code is syntax highlighted with the host's tree-sitter client and grammars,
// the same ones the built-in /diff uses. The old and new sides of each file are
// highlighted as separate documents so removed lines keep their own context.
//
// https://opencode.ai/v2/docs/build/plugins/cli

import { Plugin } from "@opencode/plugin/tui"
import { SyntaxStyle, getTreeSitterClient, pathToFiletype, treeSitterToTextChunks } from "@opentui/core"
import { For, Show, createMemo, createResource, createSignal, onCleanup } from "solid-js"

// Safety cap only; the pane's own width drives what is actually visible.
// OpenTUI's `truncate` keeps both ends of an over-long line.
const MAX_LINE_CHARS = 200
// Every file header is listed; these budgets cap the diff lines rendered across
// expanded files. The panel has room, and a scrollbox, for far more.
const MAX_FILES = 200
// The sidebar also caps each file, so one big file cannot crowd out the rest.
const SIDEBAR = { total: 400, perFile: 80 }
const PANEL = { total: 5000, perFile: Infinity }
const REFRESH_MS = 5000

const PANEL_NAME = "diff-sidebar.panel"
const MODES = ["working", "turn"]
const SOURCE_LABEL = { working: "working tree", turn: "last turn" }

function truncateEnd(text, max) {
  const value = String(text ?? "")
  if (value.length <= max) return value
  return value.slice(0, Math.max(0, max - 1)) + "\u2026"
}

function splitPath(path) {
  const value = String(path ?? "")
  const slash = value.lastIndexOf("/")
  if (slash < 0) return { dir: "", name: value }
  return { dir: value.slice(0, slash + 1), name: value.slice(slash + 1) }
}

function statusGlyph(status) {
  if (status === "added") return "A"
  if (status === "deleted") return "D"
  return "M"
}

// A patch is one file's unified diff. Drop the preamble ("diff --git", "index",
// "---", "+++", "new file mode", ...) and keep hunks and their lines.
function parsePatch(patch) {
  const lines = []
  let inHunks = false
  for (const raw of String(patch ?? "").split("\n")) {
    if (raw === "") continue
    if (raw.startsWith("@@")) {
      inHunks = true
      lines.push({ kind: "hunk", text: raw })
      continue
    }
    if (!inHunks) continue
    if (raw.startsWith("\\")) continue // "\ No newline at end of file"
    if (raw.startsWith("+")) lines.push({ kind: "add", text: raw.slice(1) })
    else if (raw.startsWith("-")) lines.push({ kind: "del", text: raw.slice(1) })
    else lines.push({ kind: "ctx", text: raw.startsWith(" ") ? raw.slice(1) : raw })
  }
  return lines
}

// Mirrors the code scopes of the host's theme-to-syntax mapping, so highlighted
// code matches the rest of the TUI.
function createSyntaxStyle(theme) {
  const s = theme.syntax
  const scope = (names, foreground, extra = {}) => ({ scope: names, style: { foreground, ...extra } })
  return SyntaxStyle.fromTheme([
    scope(["default"], theme.text.base),
    scope(["comment", "comment.documentation"], s.comment, { italic: true }),
    scope(["string", "symbol", "character.special", "character"], s.string),
    scope(["number", "boolean", "constant", "float"], s.number),
    scope(["keyword.return", "keyword.conditional", "keyword.repeat", "keyword.coroutine"], s.keyword, { italic: true }),
    scope(["keyword.type"], s.type, { bold: true, italic: true }),
    scope(["keyword.function", "function.method"], s.function),
    scope(["keyword"], s.keyword, { italic: true }),
    scope(["keyword.import", "string.escape", "string.regexp", "tag.attribute", "keyword.export"], s.keyword),
    scope(["operator", "keyword.operator", "punctuation.delimiter", "keyword.conditional.ternary"], s.operator),
    scope(["variable", "variable.parameter", "function.method.call", "function.call", "property", "parameter", "field"], s.variable),
    scope(["variable.member", "function", "constructor"], s.function),
    scope(["type", "module", "class", "namespace"], s.type),
    scope(["type.definition"], s.type, { bold: true }),
    scope(["punctuation", "punctuation.bracket"], s.punctuation),
    scope(["variable.builtin", "type.builtin", "function.builtin", "module.builtin", "constant.builtin", "variable.super"], theme.text.feedback.error.base),
    scope(["keyword.directive", "keyword.modifier", "keyword.exception"], s.keyword, { italic: true }),
    scope(["punctuation.special", "tag.delimiter"], s.operator),
    scope(["attribute", "annotation"], theme.text.feedback.warning.base),
    scope(["tag"], theme.text.feedback.error.base),
  ])
}

// Highlights `lines` as one document and returns the text chunks of each line.
async function highlightLines(lines, filetype, syntaxStyle) {
  const content = lines.join("\n")
  const result = await getTreeSitterClient().highlightOnce(content, filetype)
  if (!result?.highlights?.length) return undefined
  const out = [[]]
  for (const chunk of treeSitterToTextChunks(content, result.highlights, syntaxStyle)) {
    const parts = chunk.text.split("\n")
    parts.forEach((text, index) => {
      if (index > 0) out.push([])
      if (text) out[out.length - 1].push({ text, fg: chunk.fg, attributes: chunk.attributes })
    })
  }
  return out
}

// Per diff line, the highlighted chunks from its side: removed lines from the
// old document, added and context lines from the new one.
async function highlightPatch(lines, filetype, syntaxStyle) {
  const oldSide = []
  const newSide = []
  const where = lines.map((line) => {
    if (line.kind === "hunk") return undefined
    if (line.kind === "del") return { side: "old", index: oldSide.push(line.text) - 1 }
    const index = newSide.push(line.text) - 1
    if (line.kind === "ctx") oldSide.push(line.text)
    return { side: "new", index }
  })
  const [oldChunks, newChunks] = await Promise.all([
    oldSide.length ? highlightLines(oldSide, filetype, syntaxStyle) : undefined,
    newSide.length ? highlightLines(newSide, filetype, syntaxStyle) : undefined,
  ])
  return where.map((at) => (at ? (at.side === "old" ? oldChunks : newChunks)?.[at.index] : undefined))
}

function clipChunks(chunks, max) {
  const out = []
  let left = max
  for (const chunk of chunks) {
    if (left <= 0) break
    out.push(chunk.text.length <= left ? chunk : { ...chunk, text: truncateEnd(chunk.text, left) })
    left -= chunk.text.length
  }
  return out
}

// Shared data: the file list for the selected source, refreshed when a turn
// finishes and on a slow poll so manual edits show up. Call during component
// setup so its subscriptions and timer are tied to the component's lifetime.
function useChanges(context, getSessionID, source, fold, budget) {
  const [tick, setTick] = createSignal(0)

  // Reuse the previous object for an unchanged file, so a refresh does not
  // remount its block or highlight it again.
  let previous = new Map()
  const stable = (list) => {
    const next = new Map()
    const out = list.map((file) => {
      const kept = previous.get(file.file)
      const value = kept && kept.patch === file.patch && kept.status === file.status ? kept : file
      next.set(file.file, value)
      return value
    })
    previous = next
    return out
  }

  const [files] = createResource(
    () => `${getSessionID()}|${source.mode}|${tick()}`,
    async (key) => stable(await fetchChanges(key)),
  )

  async function fetchChanges(key) {
    const [sessionID, mode] = key.split("|")
    try {
      if (mode === "turn") {
        const result = await context.client.session.diff({ sessionID, context: 3 })
        return Array.isArray(result) ? result : []
      }
      // Diff the session's own directory, not the one the TUI was launched in.
      const location = context.data.session.get(sessionID)?.location ?? context.location
      const result = await context.client.vcs.diff({
        mode: "working",
        context: 3,
        location: location ? { directory: location.directory } : undefined,
      })
      return result?.data ?? []
    } catch {
      return []
    }
  }

  const stopEvents = [
    "session.execution.succeeded",
    "session.execution.interrupted",
    "session.execution.failed",
  ].map((type) =>
    context.data.on(type, (event) => {
      if (!event?.data?.sessionID || event.data.sessionID === getSessionID()) {
        setTick((value) => value + 1)
      }
    }),
  )
  const timer = setInterval(() => setTick((value) => value + 1), REFRESH_MS)
  onCleanup(() => {
    stopEvents.forEach((stop) => stop())
    clearInterval(timer)
  })

  const totals = createMemo(() =>
    (files() ?? []).reduce(
      (sum, file) => ({ add: sum.add + (file.additions ?? 0), del: sum.del + (file.deletions ?? 0) }),
      { add: 0, del: 0 },
    ),
  )

  // Spend the line budget on expanded files top to bottom. Collapsed files cost
  // nothing, and a file that runs past the budget is cut short, not hidden.
  const layout = createMemo(() => {
    const all = files() ?? []
    const shown = all.slice(0, MAX_FILES)
    const limits = new Map()
    let left = budget.total
    for (const file of shown) {
      if (fold.isCollapsed(file.file)) continue
      const count = parsePatch(file.patch).length
      const limit = Math.min(count, budget.perFile, Math.max(0, left))
      limits.set(file.file, limit)
      left -= limit
    }
    return { shown, limits, hiddenFiles: all.length - shown.length }
  })

  return { files, totals, layout }
}

function DiffLine(props) {
  const theme = props.theme
  const line = props.line
  const fg =
    line.kind === "add"
      ? theme.diff.text.added
      : line.kind === "del"
        ? theme.diff.text.removed
        : line.kind === "hunk"
          ? theme.diff.text.hunkHeader
          : theme.diff.text.context
  const bg =
    line.kind === "add"
      ? theme.diff.background.added
      : line.kind === "del"
        ? theme.diff.background.removed
        : line.kind === "hunk"
          ? undefined
          : theme.diff.background.context
  const sign = line.kind === "add" ? "+" : line.kind === "del" ? "-" : line.kind === "hunk" ? "" : " "
  if (line.kind === "hunk") {
    return (
      <text fg={fg} wrapMode="none" truncate={true}>
        {truncateEnd(line.text, MAX_LINE_CHARS + 4)}
      </text>
    )
  }
  // Highlighted lines keep the added/removed background and a coloured sign;
  // the code itself takes its syntax colours. A <text> does not redraw when its
  // spans change after mounting, so the highlighted line replaces it whole.
  return (
    <Show
      when={props.chunks()}
      keyed
      fallback={
        <text fg={fg} bg={bg} wrapMode="none" truncate={true}>
          {sign + " " + truncateEnd(line.text, MAX_LINE_CHARS)}
        </text>
      }
    >
      {(chunks) => (
        <text fg={fg} bg={bg} wrapMode="none" truncate={true}>
          <span style={{ fg }}>{sign + " "}</span>
          {clipChunks(chunks, MAX_LINE_CHARS).map((chunk) => (
            <span style={{ fg: chunk.fg ?? theme.text.base, attributes: chunk.attributes ?? 0 }}>
              {chunk.text}
            </span>
          ))}
        </text>
      )}
    </Show>
  )
}

function FileBlock(props) {
  const theme = props.context.theme
  const file = props.file
  const collapsed = () => props.fold.isCollapsed(file.file)
  const lines = createMemo(() => parsePatch(file.patch))
  const limit = () => props.limit() ?? lines().length
  const path = () => splitPath(file.file)
  const filetype = pathToFiletype(file.file)
  const [highlighted] = createResource(
    () => filetype,
    (ft) => highlightPatch(lines(), ft, props.syntaxStyle).catch(() => undefined),
  )
  return (
    <box flexDirection="column" flexShrink={0}>
      <box flexDirection="row" gap={1} flexShrink={0} onMouseUp={() => props.fold.toggle(file.file)}>
        <text fg={theme.text.muted}>{collapsed() ? "\u25B6" : "\u25BC"}</text>
        <text fg={theme.text.muted}>{statusGlyph(file.status)}</text>
        <text fg={theme.text.base} wrapMode="none" truncate={true}>
          <span style={{ fg: theme.text.muted }}>{truncateEnd(path().dir, 40)}</span>
          <span style={{ fg: theme.text.base }}>{path().name}</span>
        </text>
        <text fg={theme.diff.text.added}>{"+" + (file.additions ?? 0)}</text>
        <text fg={theme.diff.text.removed}>{"-" + (file.deletions ?? 0)}</text>
      </box>
      <Show when={!collapsed()}>
        <For each={lines().slice(0, limit())}>
          {(line, index) => (
            <DiffLine theme={theme} line={line} chunks={() => highlighted()?.[index()]} />
          )}
        </For>
        <Show when={limit() < lines().length}>
          <box flexShrink={0} onMouseUp={props.onMore}>
            <text fg={theme.text.muted}>{`\u2026 ${lines().length - limit()} more lines`}</text>
          </box>
        </Show>
      </Show>
    </box>
  )
}

function DiffBody(props) {
  const theme = props.context.theme
  const changes = props.changes
  return (
    <>
      <Show when={!changes.files.loading && (changes.files()?.length ?? 0) === 0}>
        <text fg={theme.text.muted}>No changes</text>
      </Show>
      <For each={changes.layout().shown}>
        {(file) => (
          <FileBlock
            context={props.context}
            file={file}
            fold={props.fold}
            syntaxStyle={props.syntaxStyle}
            limit={() => changes.layout().limits.get(file.file)}
            onMore={props.onMore}
          />
        )}
      </For>
      <Show when={changes.layout().hiddenFiles > 0}>
        <text fg={theme.text.muted}>{`\u2026 ${changes.layout().hiddenFiles} more file(s)`}</text>
      </Show>
    </>
  )
}

function DiffSidebar(props) {
  const context = props.context
  const theme = context.theme
  const changes = useChanges(context, props.sessionID, props.source, props.fold, SIDEBAR)
  const openPanel = () => context.ui.panel.open(PANEL_NAME)

  return (
    <box flexDirection="column" gap={1} flexShrink={0}>
      <box flexDirection="row" gap={1} flexShrink={0}>
        <box flexShrink={0} onMouseUp={openPanel}>
          <text fg={theme.text.base}>Changes</text>
        </box>
        <box flexShrink={0} onMouseUp={() => context.keymap.dispatch("diff-sidebar.source")}>
          <text fg={theme.text.muted}>{SOURCE_LABEL[props.source.mode] ?? props.source.mode}</text>
        </box>
        <text fg={theme.diff.text.added}>{"+" + changes.totals().add}</text>
        <text fg={theme.diff.text.removed}>{"-" + changes.totals().del}</text>
        <box flexShrink={0} onMouseUp={openPanel}>
          <text fg={theme.text.muted}>{"\u2922"}</text>
        </box>
      </box>
      <DiffBody
        context={context}
        changes={changes}
        fold={props.fold}
        syntaxStyle={props.syntaxStyle}
        onMore={openPanel}
      />
    </box>
  )
}

function DiffPanel(props) {
  const context = props.context
  const panel = props.panel
  const theme = context.theme
  const changes = useChanges(context, () => panel.sessionID, props.source, props.fold, PANEL)

  // Active only while the panel owns input.
  context.keymap.layer(() => ({
    mode: "global",
    commands: [
      { id: "diff-sidebar.panel.close", bind: "q", run: () => panel.close() },
      { id: "diff-sidebar.panel.fullscreen", bind: "f", run: panel.toggleFullscreen },
      { id: "diff-sidebar.panel.source", bind: "s", run: () => context.keymap.dispatch("diff-sidebar.source") },
      { id: "diff-sidebar.panel.collapse", bind: "c", run: () => props.fold.toggleAll(changes.layout().shown.map((f) => f.file)) },
    ],
  }))

  return (
    <box flexDirection="column" flexGrow={1} minHeight={0} gap={1}>
      <box flexDirection="row" gap={1} flexShrink={0}>
        <text fg={theme.text.base}>Changes</text>
        <text fg={theme.text.muted}>{SOURCE_LABEL[props.source.mode] ?? props.source.mode}</text>
        <text fg={theme.diff.text.added}>{"+" + changes.totals().add}</text>
        <text fg={theme.diff.text.removed}>{"-" + changes.totals().del}</text>
        <box flexGrow={1} />
        <text fg={theme.text.muted}>{"c collapse \u00b7 f full \u00b7 q close"}</text>
      </box>
      <scrollbox flexGrow={1} minHeight={0} focused={panel.focused}>
        <box flexDirection="column" flexShrink={0}>
          <DiffBody context={context} changes={changes} fold={props.fold} syntaxStyle={props.syntaxStyle} />
        </box>
      </scrollbox>
    </box>
  )
}

export default Plugin.define({
  id: "diff-sidebar",
  setup(context) {
    const [source, updateSource] = context.storage.memory("diff-sidebar.source", {
      initial: { mode: "working" },
    })
    const syntaxStyle = createSyntaxStyle(context.theme)
    const [collapsed, updateCollapsed] = context.storage.memory("diff-sidebar.collapsed", {
      initial: {},
    })
    const fold = {
      isCollapsed: (path) => collapsed[path] === true,
      toggle: (path) =>
        updateCollapsed((draft) => {
          draft[path] = draft[path] !== true
        }),
      // Collapse everything if anything is open, otherwise open everything.
      toggleAll: (paths) =>
        updateCollapsed((draft) => {
          const close = paths.some((path) => draft[path] !== true)
          for (const path of paths) draft[path] = close
        }),
    }
    const cycleSource = () =>
      updateSource((draft) => {
        const index = MODES.indexOf(draft.mode)
        draft.mode = MODES[(index + 1) % MODES.length]
      })

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "diff-sidebar.source",
          title: "Diff sidebar: switch source",
          description: "Show the working tree or the session's last turn",
          group: "Diff",
          palette: true,
          slash: { name: "sidebar-diff", aliases: ["sdiff"] },
          run: cycleSource,
        },
        {
          id: "diff-sidebar.panel",
          title: "Diff sidebar: open panel",
          description: "Open the diff in the resizable side panel",
          group: "Diff",
          palette: true,
          slash: { name: "diff-panel", aliases: ["sdp"] },
          run: () => context.ui.panel.open(PANEL_NAME),
        },
      ],
    }))

    context.ui.slot({
      append: "sidebar.content",
      render: (input) => (
        <DiffSidebar
          context={context}
          source={source}
          fold={fold}
          syntaxStyle={syntaxStyle}
          sessionID={() => input.sessionID}
        />
      ),
    })

    context.ui.slot({
      append: "session.panel",
      render: (panel) => (
        <Show when={panel.name === PANEL_NAME}>
          <DiffPanel context={context} panel={panel} source={source} fold={fold} syntaxStyle={syntaxStyle} />
        </Show>
      ),
    })

    return () => syntaxStyle.destroy?.()
  },
})
