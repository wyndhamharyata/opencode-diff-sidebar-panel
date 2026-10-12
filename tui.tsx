import { Plugin } from "@opencode/plugin/tui"
import { SyntaxStyle, getTreeSitterClient, pathToFiletype, treeSitterToTextChunks } from "@opentui/core"
import { For, Show, createMemo, createResource, createSignal, onCleanup } from "solid-js"

const maxLineCharacters = 200
const maxFiles = 200
const refreshSeconds = 5

// A per-file cap keeps one large file from pushing the rest out of view.
const sidebarLimit = { totalLines: 400, linesPerFile: 80 }
const panelLimit = { totalLines: 5000, linesPerFile: Infinity }

const panelName = "diff-sidebar.panel"
const sources = ["working", "turn"]
const sourceLabels = { working: "working tree", turn: "last turn" }
const lettersByStatus = { added: "A", deleted: "D", modified: "M" }

function truncateEnd(text, maxCharacters) {
  const value = String(text ?? "")
  if (value.length <= maxCharacters) return value
  return value.slice(0, Math.max(0, maxCharacters - 1)) + "\u2026"
}

function parsePatch(patch) {
  const lines = []
  let isInsideHunks = false

  for (const raw of String(patch ?? "").split("\n")) {
    if (raw === "") continue

    if (raw.startsWith("@@")) {
      isInsideHunks = true
      lines.push({ kind: "hunk", text: raw })
      continue
    }

    // Everything before the first @@ line is file metadata.
    if (!isInsideHunks) continue

    // Git writes this line when the file has no final newline.
    if (raw.startsWith("\\")) continue

    if (raw.startsWith("+")) lines.push({ kind: "added", text: raw.slice(1) })
    else if (raw.startsWith("-")) lines.push({ kind: "deleted", text: raw.slice(1) })
    else lines.push({ kind: "context", text: raw.startsWith(" ") ? raw.slice(1) : raw })
  }

  return lines
}

// The same theme scopes the host maps for code elsewhere.
function createSyntaxStyle(theme) {
  const syntax = theme.syntax
  const scope = (names, foreground, extra = {}) => ({ scope: names, style: { foreground, ...extra } })

  return SyntaxStyle.fromTheme([
    scope(["default"], theme.text.base),
    scope(["comment", "comment.documentation"], syntax.comment, { italic: true }),
    scope(["string", "symbol", "character.special", "character"], syntax.string),
    scope(["number", "boolean", "constant", "float"], syntax.number),
    scope(["keyword.return", "keyword.conditional", "keyword.repeat", "keyword.coroutine"], syntax.keyword, { italic: true }),
    scope(["keyword.type"], syntax.type, { bold: true, italic: true }),
    scope(["keyword.function", "function.method"], syntax.function),
    scope(["keyword"], syntax.keyword, { italic: true }),
    scope(["keyword.import", "string.escape", "string.regexp", "tag.attribute", "keyword.export"], syntax.keyword),
    scope(["operator", "keyword.operator", "punctuation.delimiter", "keyword.conditional.ternary"], syntax.operator),
    scope(["variable", "variable.parameter", "function.method.call", "function.call", "property", "parameter", "field"], syntax.variable),
    scope(["variable.member", "function", "constructor"], syntax.function),
    scope(["type", "module", "class", "namespace"], syntax.type),
    scope(["type.definition"], syntax.type, { bold: true }),
    scope(["punctuation", "punctuation.bracket"], syntax.punctuation),
    scope(["variable.builtin", "type.builtin", "function.builtin", "module.builtin", "constant.builtin", "variable.super"], theme.text.feedback.error.base),
    scope(["keyword.directive", "keyword.modifier", "keyword.exception"], syntax.keyword, { italic: true }),
    scope(["punctuation.special", "tag.delimiter"], syntax.operator),
    scope(["attribute", "annotation"], theme.text.feedback.warning.base),
    scope(["tag"], theme.text.feedback.error.base),
  ])
}

async function highlightLines(lines, filetype, syntaxStyle) {
  // One document. A string or comment that spans lines keeps its colour.
  const content = lines.join("\n")
  const result = await getTreeSitterClient().highlightOnce(content, filetype)
  if (!result?.highlights?.length) return undefined

  const chunksPerLine = [[]]
  for (const chunk of treeSitterToTextChunks(content, result.highlights, syntaxStyle)) {
    const parts = chunk.text.split("\n")
    parts.forEach((text, index) => {
      if (index > 0) chunksPerLine.push([])
      if (text) chunksPerLine[chunksPerLine.length - 1].push({ text, color: chunk.fg, attributes: chunk.attributes })
    })
  }
  return chunksPerLine
}

// Deleted lines come from the old file. Everything else comes from the new one.
async function highlightPatch(lines, filetype, syntaxStyle) {
  const oldFileLines = []
  const newFileLines = []
  const lineSource = lines.map((line) => {
    if (line.kind === "hunk") return undefined
    if (line.kind === "deleted") {
      oldFileLines.push(line.text)
      return { side: "old", index: oldFileLines.length - 1 }
    }
    if (line.kind === "context") oldFileLines.push(line.text)
    newFileLines.push(line.text)
    return { side: "new", index: newFileLines.length - 1 }
  })

  const oldChunks = oldFileLines.length ? await highlightLines(oldFileLines, filetype, syntaxStyle) : undefined
  const newChunks = newFileLines.length ? await highlightLines(newFileLines, filetype, syntaxStyle) : undefined
  const chunksBySide = { old: oldChunks, new: newChunks }

  return lineSource.map((source) => (source ? chunksBySide[source.side]?.[source.index] : undefined))
}

function clipChunks(chunks, maxCharacters) {
  const clipped = []
  let charactersLeft = maxCharacters

  for (const chunk of chunks) {
    if (charactersLeft <= 0) break
    const text = chunk.text.length <= charactersLeft ? chunk.text : truncateEnd(chunk.text, charactersLeft)
    clipped.push({ ...chunk, text })
    charactersLeft -= chunk.text.length
  }

  return clipped
}

// Call this during component setup. Its subscriptions and timer then follow the
// component's lifetime.
function useChanges(context, getSessionID, diffSource, collapse, lineLimit) {
  const [refreshCount, setRefreshCount] = createSignal(0)

  // Keep the same object for an unchanged file. A new object remounts the block
  // and highlights it again.
  let previousFiles = new Map()
  const reuseUnchangedFiles = (files) => {
    const nextFiles = new Map()
    const reused = files.map((file) => {
      const previous = previousFiles.get(file.file)
      const isUnchanged = previous && previous.patch === file.patch && previous.status === file.status
      const value = isUnchanged ? previous : file
      nextFiles.set(file.file, value)
      return value
    })
    previousFiles = nextFiles
    return reused
  }

  async function fetchChanges(key) {
    const [sessionID, selectedSource] = key.split("|")
    try {
      if (selectedSource === "turn") {
        const turnDiff = await context.client.session.diff({ sessionID, context: 3 })
        return Array.isArray(turnDiff) ? turnDiff : []
      }

      const location = context.data.session.get(sessionID)?.location ?? context.location
      const workingDiff = await context.client.vcs.diff({
        mode: "working",
        context: 3,
        location: location ? { directory: location.directory } : undefined,
      })
      return workingDiff?.data ?? []
    } catch {
      return []
    }
  }

  const [files] = createResource(
    () => `${getSessionID()}|${diffSource.selected}|${refreshCount()}`,
    async (key) => reuseUnchangedFiles(await fetchChanges(key)),
  )

  const refreshEvents = [
    "session.execution.succeeded",
    "session.execution.interrupted",
    "session.execution.failed",
  ].map((type) =>
    context.data.on(type, (event) => {
      const concernsThisSession = !event?.data?.sessionID || event.data.sessionID === getSessionID()
      if (concernsThisSession) setRefreshCount((count) => count + 1)
    }),
  )

  // The poll catches edits made outside a turn.
  const refreshTimer = setInterval(
    () => setRefreshCount((count) => count + 1),
    refreshSeconds * 1000,
  )
  onCleanup(() => {
    refreshEvents.forEach((unsubscribe) => unsubscribe())
    clearInterval(refreshTimer)
  })

  const totals = createMemo(() => {
    let additions = 0
    let deletions = 0
    for (const file of files() ?? []) {
      additions += file.additions ?? 0
      deletions += file.deletions ?? 0
    }
    return { additions, deletions }
  })

  // Collapsed files cost nothing. A file that runs past the allowance shows some
  // of its lines.
  const layout = createMemo(() => {
    const allFiles = files() ?? []
    const shownFiles = allFiles.slice(0, maxFiles)
    const lineLimits = new Map()
    let linesLeft = lineLimit.totalLines

    for (const file of shownFiles) {
      if (collapse.isCollapsed(file.file)) continue
      const lineCount = parsePatch(file.patch).length
      const limit = Math.min(lineCount, lineLimit.linesPerFile, Math.max(0, linesLeft))
      lineLimits.set(file.file, limit)
      linesLeft -= limit
    }

    return { files: shownFiles, lineLimits, hiddenFiles: allFiles.length - shownFiles.length }
  })

  return { files, totals, layout }
}

function DiffLine(props) {
  const theme = props.theme
  const line = props.line
  const styleByKind = {
    added: { sign: "+", foreground: theme.diff.text.added, background: theme.diff.background.added },
    deleted: { sign: "-", foreground: theme.diff.text.removed, background: theme.diff.background.removed },
    context: { sign: " ", foreground: theme.diff.text.context, background: theme.diff.background.context },
    hunk: { sign: "", foreground: theme.diff.text.hunkHeader, background: undefined },
  }
  const style = styleByKind[line.kind] ?? { sign: " ", foreground: theme.text.base }

  if (line.kind === "hunk") {
    return (
      <text fg={style.foreground} wrapMode="none" truncate={true}>
        {truncateEnd(line.text, maxLineCharacters + 4)}
      </text>
    )
  }

  // A text node keeps the spans it mounted with. The highlighted line replaces
  // the whole node instead.
  return (
    <Show
      when={props.chunks()}
      keyed
      fallback={
        <text fg={style.foreground} bg={style.background} wrapMode="none" truncate={true}>
          {style.sign + " " + truncateEnd(line.text, maxLineCharacters)}
        </text>
      }
    >
      {(chunks) => (
        <text fg={style.foreground} bg={style.background} wrapMode="none" truncate={true}>
          <span style={{ fg: style.foreground }}>{style.sign + " "}</span>
          {clipChunks(chunks, maxLineCharacters).map((chunk) => (
            <span style={{ fg: chunk.color ?? theme.text.base, attributes: chunk.attributes ?? 0 }}>
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
  const isCollapsed = () => props.collapse.isCollapsed(file.file)
  const lines = createMemo(() => parsePatch(file.patch))
  const lineLimit = () => props.lineLimit() ?? lines().length
  const hasHiddenLines = () => lineLimit() < lines().length
  const filetype = pathToFiletype(file.file)
  const [highlighted] = createResource(
    () => filetype,
    (value) => highlightPatch(lines(), value, props.syntaxStyle).catch(() => undefined),
  )

  const slash = file.file.lastIndexOf("/")
  const directory = slash < 0 ? "" : file.file.slice(0, slash + 1)
  const name = file.file.slice(slash + 1)

  return (
    <box flexDirection="column" flexShrink={0}>
      <box flexDirection="row" gap={1} flexShrink={0} onMouseUp={() => props.collapse.toggleFile(file.file)}>
        <text fg={theme.text.muted}>{isCollapsed() ? "\u25B6" : "\u25BC"}</text>
        <text fg={theme.text.muted}>{lettersByStatus[file.status] ?? "M"}</text>
        <text fg={theme.text.base} wrapMode="none" truncate={true}>
          <span style={{ fg: theme.text.muted }}>{truncateEnd(directory, 40)}</span>
          <span style={{ fg: theme.text.base }}>{name}</span>
        </text>
        <text fg={theme.diff.text.added}>{"+" + (file.additions ?? 0)}</text>
        <text fg={theme.diff.text.removed}>{"-" + (file.deletions ?? 0)}</text>
      </box>
      <Show when={!isCollapsed()}>
        <For each={lines().slice(0, lineLimit())}>
          {(line, index) => <DiffLine theme={theme} line={line} chunks={() => highlighted()?.[index()]} />}
        </For>
        <Show when={hasHiddenLines()}>
          <box flexShrink={0} onMouseUp={props.onShowMore}>
            <text fg={theme.text.muted}>{`\u2026 ${lines().length - lineLimit()} more lines`}</text>
          </box>
        </Show>
      </Show>
    </box>
  )
}

function DiffBody(props) {
  const theme = props.context.theme
  const changes = props.changes
  const hasNoFiles = () => !changes.files.loading && (changes.files()?.length ?? 0) === 0
  const hiddenFiles = () => changes.layout().hiddenFiles
  const hiddenFileMessage = () => `\u2026 ${hiddenFiles()} more ${hiddenFiles() === 1 ? "file" : "files"}`

  return (
    <>
      <Show when={hasNoFiles()}>
        <text fg={theme.text.muted}>No changes</text>
      </Show>
      <For each={changes.layout().files}>
        {(file) => (
          <FileBlock
            context={props.context}
            file={file}
            collapse={props.collapse}
            syntaxStyle={props.syntaxStyle}
            lineLimit={() => changes.layout().lineLimits.get(file.file)}
            onShowMore={props.onShowMore}
          />
        )}
      </For>
      <Show when={hiddenFiles() > 0}>
        <text fg={theme.text.muted}>{hiddenFileMessage()}</text>
      </Show>
    </>
  )
}

function DiffSidebar(props) {
  const context = props.context
  const theme = context.theme
  const changes = useChanges(context, props.sessionID, props.diffSource, props.collapse, sidebarLimit)
  const openPanel = () => context.ui.panel.open(panelName)

  return (
    <box flexDirection="column" gap={1} flexShrink={0}>
      <box flexDirection="row" gap={1} flexShrink={0}>
        <box flexShrink={0} onMouseUp={openPanel}>
          <text fg={theme.text.base}>Changes</text>
        </box>
        <box flexShrink={0} onMouseUp={() => context.keymap.dispatch("diff-sidebar.source")}>
          <text fg={theme.text.muted}>{sourceLabels[props.diffSource.selected]}</text>
        </box>
        <text fg={theme.diff.text.added}>{"+" + changes.totals().additions}</text>
        <text fg={theme.diff.text.removed}>{"-" + changes.totals().deletions}</text>
        <box flexShrink={0} onMouseUp={openPanel}>
          <text fg={theme.text.muted}>{"\u2922"}</text>
        </box>
      </box>
      <DiffBody
        context={context}
        changes={changes}
        collapse={props.collapse}
        syntaxStyle={props.syntaxStyle}
        onShowMore={openPanel}
      />
    </box>
  )
}

function DiffPanel(props) {
  const context = props.context
  const panel = props.panel
  const theme = context.theme
  const changes = useChanges(context, () => panel.sessionID, props.diffSource, props.collapse, panelLimit)
  const collapseAllFiles = () =>
    props.collapse.toggleAllFiles(changes.layout().files.map((file) => file.file))

  // These keys apply only while the panel owns input.
  context.keymap.layer(() => ({
    mode: "global",
    commands: [
      { id: "diff-sidebar.panel.close", bind: "q", run: () => panel.close() },
      { id: "diff-sidebar.panel.fullscreen", bind: "f", run: panel.toggleFullscreen },
      { id: "diff-sidebar.panel.source", bind: "s", run: () => context.keymap.dispatch("diff-sidebar.source") },
      { id: "diff-sidebar.panel.collapse", bind: "c", run: collapseAllFiles },
    ],
  }))

  return (
    <box flexDirection="column" flexGrow={1} minHeight={0} gap={1} paddingLeft={1} paddingRight={1}>
      <box flexDirection="row" gap={1} flexShrink={0}>
        <text fg={theme.text.base}>Changes</text>
        <text fg={theme.text.muted}>{sourceLabels[props.diffSource.selected]}</text>
        <text fg={theme.diff.text.added}>{"+" + changes.totals().additions}</text>
        <text fg={theme.diff.text.removed}>{"-" + changes.totals().deletions}</text>
        <box flexGrow={1} />
        <text fg={theme.text.muted}>{"c collapse \u00b7 f full \u00b7 q close"}</text>
      </box>
      <scrollbox flexGrow={1} minHeight={0} focused={panel.focused}>
        <box flexDirection="column" flexShrink={0}>
          <DiffBody context={context} changes={changes} collapse={props.collapse} syntaxStyle={props.syntaxStyle} />
        </box>
      </scrollbox>
    </box>
  )
}

export default Plugin.define({
  id: "diff-sidebar",
  setup(context) {
    const [diffSource, updateDiffSource] = context.storage.memory("diff-sidebar.source", {
      initial: { selected: "working" },
    })
    const [collapsedFiles, updateCollapsedFiles] = context.storage.memory("diff-sidebar.collapsed", {
      initial: {},
    })
    const syntaxStyle = createSyntaxStyle(context.theme)

    const selectNextSource = () =>
      updateDiffSource((draft) => {
        const index = sources.indexOf(draft.selected)
        draft.selected = sources[(index + 1) % sources.length]
      })

    const collapse = {
      isCollapsed: (path) => collapsedFiles[path] === true,
      toggleFile: (path) =>
        updateCollapsedFiles((draft) => {
          draft[path] = draft[path] !== true
        }),
      toggleAllFiles: (paths) =>
        updateCollapsedFiles((draft) => {
          const shouldCollapseAll = paths.some((path) => draft[path] !== true)
          for (const path of paths) draft[path] = shouldCollapseAll
        }),
    }

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "diff-sidebar.source",
          title: "Switch the diff source",
          description: "Show the working tree or the session's last turn",
          group: "Diff",
          palette: true,
          slash: { name: "sidebar-diff", aliases: ["sdiff"] },
          run: selectNextSource,
        },
        {
          id: "diff-sidebar.panel",
          title: "Open the diff panel",
          description: "Open the diff in the resizable side panel",
          group: "Diff",
          palette: true,
          slash: { name: "diff-panel", aliases: ["sdp"] },
          run: () => context.ui.panel.open(panelName),
        },
      ],
    }))

    context.ui.slot({
      append: "sidebar.content",
      render: (input) => (
        <DiffSidebar
          context={context}
          diffSource={diffSource}
          collapse={collapse}
          syntaxStyle={syntaxStyle}
          sessionID={() => input.sessionID}
        />
      ),
    })

    context.ui.slot({
      append: "session.panel",
      render: (panel) => (
        <Show when={panel.name === panelName}>
          <DiffPanel
            context={context}
            panel={panel}
            diffSource={diffSource}
            collapse={collapse}
            syntaxStyle={syntaxStyle}
          />
        </Show>
      ),
    })

    return () => syntaxStyle.destroy?.()
  },
})
