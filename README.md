# opencode-diff-sidebar-panel

An [OpenCode](https://opencode.ai) TUI plugin that puts your changes in the
sidebar, and a resizable panel when you need more room.

OpenCode's sidebar is 42 columns wide, which is fine for a file list but tight
for a diff. This plugin shows a compact unified diff there anyway — in the style
of OpenCode's own web/share view — and opens the same diff in the session panel
when you want it wider.

## What it looks like

Sidebar, on a real session (a live change, showing the session's last turn):

![The diff in the sidebar](docs/sidebar.svg)

The panel, opened from the sidebar header (shown full screen with `f`):

![The same diff in the panel](docs/panel.svg)

Both are unedited captures of a real OpenCode window. To fit several files in
one screen, the larger generated files in that session were collapsed — click a
file header to do the same.

## Features

- **Compact unified diff in the sidebar.** One block per file, the directory
  dimmed and the filename emphasised, `+N -M` counts, and whole-line
  added/removed backgrounds.
- **A resizable diff panel.** The same diff in the right-hand pane, where you
  can drag the divider and toggle full screen.
- **Syntax highlighting** for any language OpenCode's tree-sitter setup covers,
  using your OpenCode theme. Nothing extra to install.
- **Collapsible files.** Click a file header, or press `c` in the panel to
  collapse or expand them all. Collapsed files stay collapsed across refreshes.
- **Two sources.** The working tree (uncommitted edits, the default) or the
  session's last turn.
- **Stays current.** Refreshes when a turn finishes, and polls every 5 seconds
  so manual edits show up.

## Requirements

- OpenCode v2.0.0 or newer. This plugin uses the v2 TUI plugin API.
- A git (or other VCS) project for the working-tree source.

## Install

The plugin is a single file. Clone the repo somewhere and tell OpenCode's CLI
config about it.

```sh
git clone https://github.com/wyndhamharyata/opencode-diff-sidebar-panel.git \
  ~/.config/opencode/plugins/diff-sidebar
```

Then add it to `~/.config/opencode/cli.json`:

```json
{
  "plugins": ["./plugins/diff-sidebar"]
}
```

Restart OpenCode. The "Changes" section should appear in the sidebar of any
session that has changes.

<details>
<summary>Installing from somewhere else</summary>

Any path in `cli.json` works — relative to the config directory, absolute, or a
`file://` URL:

```json
{
  "plugins": ["/Users/you/code/opencode-diff-sidebar-panel"]
}
```

The directory just needs the `tui.tsx` entrypoint (declared as the `./tui`
export in `package.json`). No `npm install` is needed: OpenCode provides
`@opencode/plugin`, `@opentui/*` and `solid-js` to plugins at runtime.

</details>

## Usage

The sidebar section is always on. For the wider view, click **Changes**, click
the `⤢` glyph, or run the `/diff-panel` command.

| Command | Slash | Does |
| --- | --- | --- |
| Diff sidebar: open panel | `/diff-panel` (`/sdp`) | Open the diff in the resizable panel |
| Diff sidebar: switch source | `/sidebar-diff` (`/sdiff`) | Switch between the working tree and the last turn |

Both are in the command palette (`ctrl+p`). You can bind either to a key by
command id in `cli.json`, for example `"keybinds": { "diff-sidebar.panel": "ctrl+shift+d" }`.

In the panel:

| Key | Does |
| --- | --- |
| `f` | Toggle full screen |
| `c` | Collapse or expand every file |
| `s` | Switch source |
| `q` | Close the panel |

In both views, click a file header to collapse or expand that file.

## Notes and limits

- The sidebar is a fixed 42 columns wide in OpenCode v2. That is why the panel
  exists: it is the same pane, resizable and half the window by default.
- Lines that do not fit are truncated, keeping both ends.
- Only recognised languages are highlighted; everything else shows uncoloured.
- LSP is not used. It describes the current contents of a file, so it cannot
  colour removed lines or the context around a change.
- Every changed file is listed. To stay fast, the sidebar shows at most 80 lines per file and
  400 lines in total across expanded files; the rest is cut short with "… N more lines", which
  opens the panel. The panel shows up to 5000 lines. Collapsed files don't count.

## License

MIT. See [LICENSE](LICENSE).
