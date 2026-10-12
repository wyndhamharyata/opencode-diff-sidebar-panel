# opencode-diff-sidebar-panel

An [OpenCode](https://opencode.ai) TUI plugin. It shows your changes in the
session sidebar. It also opens the same diff in a resizable panel.

The OpenCode sidebar is 42 columns wide. That width suits a file list and is
tight for a diff. This plugin still fits a compact unified diff there. The
result follows the diff view on OpenCode's own share page.

## What it looks like

Sidebar, on a real session:

![The diff in the sidebar](docs/sidebar.svg)

The same diff in the panel, opened from the sidebar header and shown full screen
with `f`:

![The same diff in the panel](docs/panel.svg)

Both images are unedited captures of a real OpenCode window. The larger
generated files in that session are collapsed to fit several files on one
screen. A click on a file header does the same in any session.

## Features

- A compact unified diff in the sidebar. One block per file. The directory is
  dimmed and the filename is in full. Every file carries its `+N` and `-M`
  counts.
- A second home in the panel. The same diff opens in the right-hand pane. The
  divider drags the panel wider. `f` fills the screen.
- Syntax colours for every language OpenCode can highlight, taken from your
  OpenCode theme. Nothing else to install.
- Collapsible files. Click a file header, or press `c` in the panel to collapse
  every file at once. A collapsed file stays collapsed through a refresh.
- Two sources. The working tree is the default. The session's last turn is the
  other.
- Fresh data. The list refreshes when a turn ends. A slow poll picks up manual
  edits.

## Requirements

- OpenCode v2.0.0 or newer. The plugin uses the v2 TUI plugin API.
- A project under git, or another version control system, for the working tree
  source.

## Install

The plugin is one file. Clone the repo and point OpenCode's CLI config at it.

```sh
git clone https://github.com/wyndhamharyata/opencode-diff-sidebar-panel.git \
  ~/.config/opencode/plugins/diff-sidebar
```

Add it to `~/.config/opencode/cli.json`:

```json
{
  "plugins": ["./plugins/diff-sidebar"]
}
```

Restart OpenCode. The Changes section then appears in the sidebar of any session
with changes.

<details>
<summary>Installing from somewhere else</summary>

Any path in `cli.json` works. It can point at a folder next to the config file,
at an absolute path, or at a `file://` URL. For example:

```json
{
  "plugins": ["/Users/you/code/opencode-diff-sidebar-panel"]
}
```

The folder needs the `tui.tsx` entrypoint, which `package.json` names as the
`./tui` export. No `npm install` step is needed. OpenCode hands `@opencode/plugin`,
`@opentui/*` and `solid-js` to a plugin at load time.

</details>

## Use it

The sidebar section is always on. For the wider view, click **Changes**, click
the `⤢` glyph, or run `/diff-panel`.

| Command | Slash | What it does |
| --- | --- | --- |
| Switch the diff source | `/sidebar-diff` (`/sdiff`) | Show the working tree or the session's last turn |
| Open the diff panel | `/diff-panel` (`/sdp`) | Open the diff in the resizable panel |

Both sit in the command palette (`ctrl+p`). A key can run either one, by command
id, in `cli.json`. For example
`"keybinds": { "diff-sidebar.panel": "ctrl+shift+d" }`.

Inside the panel:

| Key | What it does |
| --- | --- |
| `f` | Fill the screen with the diff |
| `c` | Collapse or expand every file |
| `s` | Switch the source |
| `q` | Close the panel |

In both views, a click on a file header collapses or expands that file.

## Notes and limits

- The OpenCode v2 sidebar is a fixed 42 columns wide. The panel removes that
  limit. It uses the same pane. It starts at half the window. The divider drags
  it wider.
- A line that does not fit is shortened, with both ends kept.
- Only recognised languages get colours. Everything else stays plain.
- LSP is not involved. LSP describes the current contents of a file. It says
  nothing about removed lines, or about the code around a change.
- Every changed file is listed. The sidebar shows at most 80 lines of a file and
  400 lines across the expanded files. The rest shortens to "… N more lines". A
  click on that line opens the panel. The panel shows up to 5000 lines. A
  collapsed file uses none of the allowance.

## License

MIT. See [LICENSE](LICENSE).
