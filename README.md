# App Grid Only

A minimal GNOME Shell 51 extension that shows the **native application grid directly on Super**, without workspace previews or thumbnails.

## What it does

| Action | Result |
|--------|--------|
| Press **Super** | Opens the native app grid immediately |
| Press **Super** again or **Escape** | Closes the grid |
| Type anything | Native GNOME search, as usual |

Everything in the grid is 100 % native GNOME: icons, layout, pagination, search, animations, and app launching are untouched. Only the workspace thumbnails and workspace overview are hidden.

## Requirements

- GNOME Shell **51 / 51.1**
- Wayland session (CachyOS, Arch, Fedora …)

## Installation

```bash
git clone https://github.com/Fkj94/app-grid-only.git
cd app-grid-only
gnome-extensions pack --force
gnome-extensions install --force app-grid-only@fkj94.shell-extension.zip
gnome-extensions enable app-grid-only@fkj94
```

Then log out and back in, or press **Alt+F2**, type `r`, and press Enter to restart the Shell (X11 only). On Wayland, log out and back in.

## Update after editing

```bash
gnome-extensions pack --force
gnome-extensions install --force app-grid-only@fkj94.shell-extension.zip
gnome-extensions disable app-grid-only@fkj94
gnome-extensions enable app-grid-only@fkj94
```

## How it works

The extension uses GNOME Shell's official `InjectionManager` API to surgically override 11 prototype methods across `Overview`, `ControlsManagerLayout`, `ControlsManager`, `SearchController`, and `WorkspacesDisplay`. No system files are modified. All overrides are fully restored when the extension is disabled.

| Prototype | Method overridden | Why |
|-----------|-------------------|-----|
| `Overview` | `show`, `_animateVisible` | Force `APP_GRID` state instead of `WINDOW_PICKER` |
| `ControlsManagerLayout` | `_computeWorkspacesBoxForState` | Give workspace area zero height in APP_GRID |
| `ControlsManagerLayout` | `_getAppDisplayBoxForState` | Expand app grid to fill the freed space |
| `ControlsManager` | `_shiftState` | Prevent falling back to WINDOW_PICKER |
| `ControlsManager` | `_onShowAppsButtonToggled` | Dash button → APP_GRID or close |
| `ControlsManager` | `_onSearchChanged` | Keep workspaces hidden during search |
| `ControlsManager` | `gestureBegin`, `gestureEnd` | Gestures snap between HIDDEN and APP_GRID only |
| `SearchController` | `_onStageKeyPress` | Escape resets search or closes the grid |
| `WorkspacesDisplay` | `prepareToEnterOverview` | Hide workspaces + secondary monitor views on entry |

## UUID

`app-grid-only@fkj94`

## License

MIT
