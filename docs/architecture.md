# Architecture

## Overview

Android File Transfer for macOS is an Electron desktop app with three layers:

- Renderer: React UI for device state, dense file browsing, destination selection, and transfer queue visibility.
- Main process: Electron IPC, folder picker, Finder reveal, logging, and sequential transfer queue control.
- Native helper: `resources/bin/mtp-json`, compiled from `src/native/mtp-json.c`, using libmtp.

## MTP Bridge

The native helper exposes one-shot diagnostic commands plus a long-lived session command:

```sh
mtp-json status
mtp-json inventory
mtp-json list <device-index> <storage-id> <parent-id>
mtp-json download <device-index> <object-id> <destination-path>
mtp-json mkdir <device-index> <storage-id> <parent-id> <folder-name>
mtp-json upload <device-index> <storage-id> <parent-id> <source-path>
mtp-json session <device-index>
```

`status` runs libmtp raw device detection and returns a JSON state such as `no-device`, `connect-error`, or `connected`.

The Electron app uses `session` for normal work. The helper opens one libmtp device session, then accepts stdin commands for inventory, folder listing, and download. This avoids reopening the Samsung/macOS MTP session between browse and copy operations. When the main process closes an idle normal session, it sends the helper's `quit` command first so the helper can call `LIBMTP_Release_Device`; forced `SIGTERM`/`SIGKILL` is only a fallback for a stuck open, timeout, or canceled active transfer.

The one-shot `inventory` command remains useful for diagnostics. Inventory reads storage metadata only. It does not recursively walk the full phone, because large Samsung-class media libraries can make a whole-device scan too slow for startup.

Folder contents are loaded on demand with:

```sh
mtp-json list <device-index> <storage-id> <parent-id>
```

`list` calls `LIBMTP_Get_Files_And_Folders` for one storage/folder and emits JSON objects with:

- object ID
- parent ID
- storage ID
- name
- kind
- size
- modified timestamp
- libmtp filetype

Storage-root navigation uses libmtp's root parent ID `0xffffffff`.

`download` calls `LIBMTP_Get_File_To_File` for one object ID and emits newline-delimited JSON progress events. `mkdir` calls `LIBMTP_Create_Folder` for non-destructive phone-side folder creation. `upload` calls `LIBMTP_Send_File_From_File` for one Mac file and verifies the returned destination metadata before a Mac source can be removed. The session-only `delete` command calls `LIBMTP_Delete_Object`; main invokes it only after an explicitly confirmed phone-to-Mac file Move has atomically published the destination. In app mode, these commands run inside the active `session` worker. The Electron main process owns cancellation by terminating that worker and reopening it on the next command.

Download progress is throttled in the native helper to about one event per MiB plus completion. This keeps large video copies observable without flooding the Electron IPC path or diagnostic logs.

Transfer commands use an idle timeout rather than a fixed wall-clock limit: the main process arms the command timeout when a download or upload starts, and that idle timeout is refreshed on native progress events. A 4GB+ video copy can therefore keep running as long as bytes are still moving, while a stuck command that stops reporting progress is still terminated and shown as failed.

The main process wraps session open, inventory, and folder-list calls with timeouts. If the helper hangs while opening the phone session, the wrapper asks the helper to quit, then force-stops it if it does not exit, and shows diagnostics from libmtp/libusb. Known Samsung/macOS failure signatures include `PTP_ERROR_IO: failed to open session`, `libusb_detach_kernel_driver() failed`, and macOS USB-capture warnings that mention `com.apple.vm.device-access` or root privilege.

If Samsung storage metadata is missing after a successful open, the helper exposes a synthetic Phone storage row using the reserved internal sentinel `0xfffffffe`; it does not claim that the phone reported storage ID `65537`. Opening that row lazily loads one full object index with progress and caches it for the session. Folder browsing filters the cached index, while folder creation and upload resolve one real nonzero storage ID from the index or fail explicitly if a unique writable target cannot be proven.

When a session open fails, the main process does not permanently block the same raw USB address. A visible phone remains retryable, because Android may still be waiting for the user to tap `Allow access to phone data` or may finish granting access seconds after the first failed open.

The renderer blocks repeated automatic scans by USB identity aliases. The exact alias includes vendor ID, product ID, serial when available, vendor label, product label, and visible USB mode; broader automatic-retry aliases also include vendor ID, product ID, serial, and USB mode without the labels, plus vendor ID/product ID/USB mode as a final background-scan guard. Samsung phones may bounce between raw USB addresses and labels such as `Samsung Galaxy models (MTP)` and `SAMSUNG_Android` after an access prompt, so raw-address or label tracking alone is not enough. When macOS reports a USB `sessionID`, automatic failure blocking is scoped to that session first; a real unplug/replug creates a new session and gets a fresh attempt instead of inheriting stale `GetStorage` or folder-listing errors. Background polling checks phone status every 3 seconds, tries once after an automatic open failure for the same visible attachment, then stops asking that attachment to reopen files until the user chooses Check now, uses Open files, or reconnects/changes USB mode. The blocked aliases are also stored in renderer local storage, so relaunching the app does not immediately reopen the same known-blocked attachment and trigger another Android Allow prompt. A visible identity change, such as switching from File Transfer to another USB mode and back, clears the stale automatic-failure block; raw address or label churn with the same USB session does not. This prevents the app from making Android ask for `Allow access to phone data` repeatedly while still leaving the user in control.

An alternate `whoozle/android-file-transfer-linux` CLI backend was cloned and built locally under `android-file-transfer-linux` / `aft-build` for comparison. Its native Darwin backend can see the same Samsung `MTP` interface, but in the currently stuck USB state it also hangs or fails before listing storage. This confirms the current failure is below libmtp-specific code.

`mtp:recoverWithAdmin` is the product Open files path for the macOS USB-capture/root boundary. It first runs a normal raw-device status check; the native helper falls back to IOKit USB detection when libmtp misses an Android device that macOS still lists, with the older libusb-only fallback kept as a backup. Samsung `04e8:6860` is treated as MTP/File Transfer visible in that fallback state. If IOKit reports `NeedsDeviceAccessEntitlement`, that protected-USB signal is preserved in raw device status and surfaced in the renderer's Details panel. The IOKit fallback also preserves macOS `sessionID` as `usbSessionId`, so Details and Copy Report can prove whether a cable unplug/replug created a new USB attachment or the app is still looking at the same stuck attachment. Only if raw MTP is visible does the renderer offer Open files. The UI shows the connection as explicit stages: Cable, File transfer, Open files, Storage, and Folder list. This keeps a USB-visible/file-session-closed phone from being described as a generic storage failure. The main USB-visible/file-session-not-open panel owns the detailed recovery instructions, while the sidebar shows only a compact Open files action that calls the same protected flow. The main process shows a plain-language explanation before the macOS password prompt, including why the next window may say `osascript wants to make changes`.

If the user continues, the main process asks macOS for administrator permission through `osascript`. User-owned staging files are copied and hash-verified into a random root-owned directory under `/private/var/tmp`; helper libraries and the runner are not executed from a user-writable location. The runtime's `ipc` directory is root-owned and non-writable, while its fixed FIFO, output, PID, stop, and expiry files are owned by the logged-in user. This prevents pathname replacement without blocking normal app communication. The runner starts the helper with a minimal `env -i` environment. The helper may open the USB device while elevated, but it must call `initgroups`, `setgid`, and `setuid` before emitting successful `ready` or accepting any file command. Photos, Image Capture, and macOS camera/import services are never killed; the app only reports them as a troubleshooting hint.

Protected open waits longer than normal open because Samsung/macOS may need a reset and reclaim cycle after `PTP_ERROR_IO`. The runner can retry pre-ready failures within the same password approval. The helper's `ready` payload includes bus, address, VID/PID, serial, and USB session metadata; main verifies that against the requested physical connection before accepting the worker. Inventory responses carry per-device `protectedAccess`, and normal and protected sessions expose all open connection IDs so multiple phones are not collapsed into one global state. A native index is only a routing hint: every command and transfer job carries the physical connection ID, and main resolves its current index just before use. Switching a normal worker to another phone waits for the prior helper to exit so USB ownership cannot overlap.

An idle protected session can detach across an app relaunch using a versioned short-lived manifest. All manifest paths must remain inside the generated protected runtime root, and reattachment requires the exact USB connection ID. A new USB session invalidates the old worker. Cancellation writes the fixed stop file; the root runner terminates its child and removes its own runtime directory after preserving the exit marker briefly. There is no separate root-running smoke script; protected access is exercised only through the hardened app path.

Once a normal or protected session is open, polling is not allowed to close it just because Samsung/macOS reports a different transient USB bus/address. The main process exposes `sessionOpen` on status responses and keeps the worker alive across raw-address churn. If the raw USB device disappears entirely during a normal user-owned session, cleanup waits through a short grace period before closing that normal session. A protected session is stricter in the other direction: the separate raw status probe may lose sight of the interface because the protected helper owns it, so the main process keeps the protected session alive until the protected helper exits, a protected command fails, or the user/app stops it. The renderer preserves the visible inventory while `sessionOpen` is true, so a later status poll cannot replace a working file browser with a blocked-access screen. A status label alone is not enough to prove the phone files are gone.

## Device Discovery

The renderer requests `mtp:getStatus` on launch and then checks automatically every 3 seconds. These routine checks are silent and only update meaningful connection state; the sidebar does not show the polling cadence or a constantly changing last-check time. Check now is only an immediate retry fallback, shows one compact result, and runs the same guarded status path:

1. `mtp:getStatus`
2. if connected, `mtp:scanInventory`, which opens or reuses the persistent `mtp-json session` worker
3. reset navigation to device root
4. fetch folder contents lazily through `mtp:listFolder` when the user opens a storage or folder

If inventory returns more than one MTP device, the renderer keeps a selected physical connection ID and shows a compact Phones selector in the sidebar. The native device index is only a current routing hint and may change after USB re-enumeration. Switching phones resets phone navigation, selection, drag-ready state, and folder-list tokens. Folder cache keys and row keys include the connection ID so two phones with the same storage or object IDs cannot share stale rows.

The UI preserves clear states for no device, USB mode, USB-visible/file-session-not-open, locked-phone/permission-waiting state, missing helper, folder listing, and connected inventory. The native helper still reports most refused MTP opens as `connect-error`, so the renderer uses message and raw-device evidence to show Unlock phone guidance when Android likely still needs the screen unlocked or the Allow data-access prompt answered. When raw MTP is visible but the file session is not open, the status pill says `USB visible`, Details shows `File session`, and the main panel explains that File Transfer visibility is not the same as readable folders. User-facing guidance stays in the main browser area and sidebar; raw helper paths, USB session IDs, and native errors remain in Details. Simple waiting panels say the app checks automatically, while Check now feedback appears once in the sidebar.

Large folder listings always show elapsed time and an indeterminate bar. When the Samsung full-index callback reports a usable `sent/total`, main forwards a connection/storage/parent-scoped `folder-list:progress` event and the same bar becomes determinate. Each progress event also rearms the command idle timeout. Stop listing cancels active or queued `list` and `inventory` commands and invalidates the renderer's request token. A NULL storage-root result is not treated as an empty folder. For synthetic Samsung Phone storage, `LIBMTP_Get_Filelisting_With_Callback` runs at most once per session, emits newline-delimited progress JSON, and keeps the returned object tree until mutation or session close; later folders filter that tree rather than rescanning the phone.

The renderer HTML includes a static startup fallback inside `#root`, so a bundle-load failure is visible instead of a blank white window. Once React starts, `RendererErrorBoundary` catches render-time failures and shows a display-problem screen with Relaunch Window and Open Log actions when preload is available.

The Details panel also exposes Copy Report. The renderer calls `mtp:copyDiagnostics`, preload forwards it as `window.mtp.copyDiagnostics`, and the main process builds the text and writes it with Electron's clipboard API. The report includes app/runtime version, helper path, log path, status message, raw USB metadata, current session flags, aggregate queue counts, camera/import service hints, and recent native stderr. It does not include phone file listings, so users can share connection evidence without accidentally dumping folder contents.

The phone and Mac panes are keyboard-addressable. The renderer tracks the active pane so Cmd/Ctrl+1 focuses the phone pane, Cmd/Ctrl+2 focuses the Mac pane, Cmd/Ctrl+A selects visible rows in the right pane, Cmd/Ctrl+C copies the active file selection into an internal transfer clipboard, Cmd/Ctrl+V pastes that transfer clipboard to the opposite pane, Cmd/Ctrl+Enter and Cmd/Ctrl+Shift+C copy in the right direction immediately, Cmd/Ctrl+B goes to the parent folder, Cmd/Ctrl+N opens the phone New Folder dialog, Cmd/Ctrl+F focuses Filter, Cmd/Ctrl+R checks the phone now, and arrow/Enter keys navigate selected folders without hijacking text fields or buttons. The transfer clipboard never publishes phone object IDs to the system clipboard; it reuses the existing safe queue path, rejects stale copied phone selections when that phone is no longer connected, and still lets editable text fields keep normal copy/paste behavior. Hidden-file visibility is a persisted renderer preference exposed from the toolbar and View menu; it filters dotfiles and dotfolders from phone rows and asks the main process to include or hide Mac dotfiles when listing local folders. Hidden files are hidden by default. The Mac pane keeps its own back/forward stacks, common user-folder shortcuts, and clickable path breadcrumbs so local folder browsing behaves like a normal file pane rather than a static destination picker. The divider between the phone browser and Mac pane is also keyboard-addressable: Arrow Left/Right adjusts the Mac pane width, Shift+Arrow uses a larger step, and Home/End jump between the clamped minimum and maximum. In grid view, phone Arrow Left/Right move by tile and Arrow Up/Down move by the computed grid column count; Enter opens the selected tile. Destructive OpenMTP shortcuts such as Backspace delete, rename, and move are intentionally not wired in v1.

Mouse selection mirrors standard file managers and OpenMTP's documented behavior. Cmd/Ctrl-click toggles individual visible rows, while Shift-click selects the visible range from the last anchored phone row or Mac row to the clicked row. Each pane keeps its own selection anchor, and anchors are reset when navigation or folder changes clear the visible list. The phone summary strip always keeps the current folder count/size visible, then swaps the guidance text for a selection summary when rows are selected. The Mac action strip does the same for selected local files and folders. These summaries show selected item counts, selected file counts, known selected file size, and the next safe action so a single click has immediate visible feedback.

Right-click context menus are renderer-only affordances over the same safe handlers used by toolbar buttons, keyboard shortcuts, and app menu commands. Phone context menus can open storage/folders, copy selected phone files/folders to the Mac, stop a slow listing, go up, create a phone folder, or check the phone now. Dragging itself has no preparation command. Mac context menus can open folders, copy selected Mac files/folders to the phone, reveal a row in Finder, go up, refresh the current Mac folder, choose another Mac folder, or switch to Desktop.

The Electron main process installs a native application menu and forwards safe app commands over `app-menu:command`. Preload exposes that as `window.mtp.onAppMenuCommand`, and the renderer dispatches each command through the same state-aware handlers used by toolbar buttons and keyboard shortcuts. This keeps Mac menu actions such as New Folder, Check Phone Now, Copy File Selection, Paste File Selection, Copy to Queue, and Folder Up discoverable without duplicating transfer logic in the main process.

Appearance is a renderer-only preference. The topbar exposes light, dark, and system modes; the selected mode is stored in `localStorage`, and system mode follows `prefers-color-scheme`. CSS scopes the resolved theme on `.app-shell[data-theme]` so dense table, queue, dialog, and connection-help surfaces share the same tokens. The shell intentionally uses a native, neutral file-manager treatment rather than OpenMTP-style decorative chrome or always-visible debug details.

## File Listing

The renderer builds table rows from the current browser location and a per-folder cache:

- Device root: storage rows
- Storage root: cached result for parent ID `0xffffffff`
- Folder: cached result for the folder object ID

Storage entries in the sidebar use the same MTP storage metadata as the device-root rows. When total capacity is available, the sidebar shows used-of-total text, free-space text, and an accessible meter so users can understand phone capacity without opening a folder. If the phone does not report capacity metadata, the UI says the capacity is unavailable instead of rendering `0 B`.

Phone rows are sorted by name, size, modified date, or type, with folders kept above files. Mac rows use the same visible-order model for Name, Size, Modified, and Kind sorting, so keyboard movement, Shift-click range selection, and row rendering all follow the active Mac sort. File size and modified date come from libmtp for phone rows and filesystem stat data for Mac rows. After a phone folder finishes listing, the renderer summarizes the current folder with folder count, file count, and total file size. That summary uses only the current listing and does not recursively scan subfolders.

Each folder-list request carries a renderer-side token. If the user presses Stop or navigates away while the native command is still resolving, a late response is ignored instead of repainting the old folder after the UI has moved on.

The renderer defaults to the compact list/table view required for file-management work. A persisted phone-pane view preference can switch the same `rows` data to a compact grid. Grid tiles intentionally reuse the same selection, double-click open, immediate file-promise drag, and copy-to-Mac paths as table rows; the view switch changes presentation only. The Mac side is also a first-class file pane, not a small destination picker: it reserves a desktop-width column, has a persisted resizable split clamped so the phone table stays usable, shows sortable Finder-style Name, Modified, Kind, and Size fields, and leaves transfer status below the Mac browser.

## Transfer Queue

The renderer lists the current Mac folder through `local:listDirectory` and uses that folder as the Mac-side destination. With no explicit folder selected, the main process starts the Mac pane at the user Home folder. It also exposes `local:getCommonFolders`, which returns existing Home, Downloads, Documents, Pictures, Movies, and Desktop paths from Electron's own `app.getPath()` values. Desktop remains an explicit choice rather than the default. Selected phone folders expand recursively through `mtp:listFolder`; required Mac directories are created before file jobs begin, including real empty folders. After atomic file publication, `preserveDownloadedModifiedTime` restores the phone timestamp. Planned folder timestamps are restored deepest-first through `setLocalModifiedTime` after child jobs finish. Timestamp restoration failure is logged as a non-fatal warning because the validated file copy has already completed.

Each phone-to-Mac download streams to a hidden same-directory `.partial` path. Main validates the completed file's type and expected size, then publishes it with an atomic no-clobber hard link. Existing names and names reserved by ordinary queued copies receive numbered alternatives and set `renamedDestination`; a file created by another process during the copy is never overwritten. A file promise uses the exact coordinated URL selected by the receiver and fails rather than silently renaming it. Failed and canceled jobs remove their partial path. The `downloadSpaceError` preflight reserves known sizes by filesystem device (volume), including the actual volume selected by a file-promise drop.

Mac-to-phone upload planning lists every destination folder before queuing. A failed list stops planning instead of being interpreted as an empty folder. Any same-name phone item is a conflict regardless of size, and the native helper repeats that check immediately before `LIBMTP_Send_File_From_File`. Local traversal uses `lstat`, skips symbolic links, and caps file, folder, and nesting counts. The renderer also exposes New Folder for the current phone location.

Native drag-out uses an Objective-C++ bridge because Electron's public `startDrag` API only accepts local paths. The bridge creates one `NSFilePromiseProvider` per selected phone file or folder and starts an AppKit dragging session from Electron's native `NSView`. No MTP command runs when dragging begins. After Finder, Desktop, another compatible app, or the native Mac-pane receiver accepts the drop, AppKit supplies the exact destination URL. Main then plans any folder tree and queues ordinary downloads directly to that destination. `NSFileCoordinator` encloses fulfillment, and the bridge reports success only after every file is atomically published and folder timestamps are restored. Cancellation, disconnect, failure, or app quit rejects the promise and removes app-owned partial output. Dragging is always Copy; verified Move remains an explicit command.

Recursive phone-to-Mac folder copy has a planning stage before transfer jobs exist, because the app must list nested MTP folders to know which files to queue and which local directories to create. During that stage, `phoneDownloadPlanning` drives the top status pill to Preparing and renders one compact Preparing folder copy card in the queue pane. The card uses an indeterminate progress bar plus live file and folder counts from the recursive planner, so a slow MTP folder expansion has visible feedback before byte-level progress starts. Its Stop button flips a renderer cancellation flag and calls `cancelFolderListing` so the active native `list` command is terminated; the recursive planner checks that flag before queuing downloads and reports that nothing was copied.

Phone drag-out never publishes `text/plain`, which prevents Finder/Desktop from creating `.textClipping` files such as `object-43642.textClipping`. Selecting, hovering, scrolling, beginning a drag, or canceling it performs no MTP transfer. An accepted file promise emits destination-aware planning feedback and then normal byte progress. The native bridge also installs a temporary transparent promise receiver over the Mac pane during the drag, so dropping there fulfills the same promise into the currently displayed folder. Mac-pane source rows still use Electron native drag immediately because their local paths already exist.

Finder-to-phone drops use Electron's `webUtils.getPathForFile` in preload to resolve the dropped Mac `File` objects to local paths, then `local:inspectPath` classifies each path as a file or folder. The native helper creates folders with `LIBMTP_Create_Folder` and uploads files with `LIBMTP_Send_File_From_File` and libmtp metadata for the selected storage and parent folder.

Each job tracks:

- queued, active, completed, failed, or canceled state
- bytes transferred
- total bytes
- speed
- ETA
- error details
- final destination path or phone target URI

The renderer also folds those jobs into an aggregate queue summary. It shows overall percent, copied-of-total bytes, active speed, aggregate ETA from remaining bytes, and counts for completed, failed, and canceled jobs. The top connection pill switches to Transferring, Transfer queued, or Preparing while queue work is active, so transfer state is visible even when the user's attention is on the phone browser. Bulk controls cancel every active or queued job through the same `mtp:cancelTransfer` IPC path used by individual queue rows, and Clear Finished removes only completed, failed, or canceled rows from the visible history.

Completed downloads can be revealed in Finder. Failed or canceled ordinary jobs can be retried; download retry creates a fresh unique destination path and re-runs the Mac free-space preflight. A failed promised job cannot be retried because the receiving app has already rejected that promise, so the queue tells the user to drag again.

Verified file Move is a queue operation, not a general delete API. The main process owns the confirmation dialog and forces ordinary `startDownloads` and `startUploads` calls to Copy even if renderer input claims otherwise. Phone-to-Mac Move publishes and validates the local file before sending the source object ID to the session-only delete command. Mac-to-phone Move requires the phone to report the exact uploaded object ID with a matching name and size, then rechecks the Mac source device, inode, size, modification time, and change time. It atomically renames that exact source inode to a unique same-folder quarantine name, checks the identity again, and only then unlinks it; this prevents a replacement at the original path from being deleted in a check/unlink race. If any validation or deletion step fails, the job completes as `copied; source kept` and restores the original name when possible. Folder Move is intentionally unavailable because it would require an aggregate transaction and bottom-up source deletion after every child succeeds.

## v1 Boundaries

The app still excludes general destructive phone-side mutation:

- no standalone delete
- no rename or overwrite
- no folder Move
- file deletion occurs only as the final verified step of an explicitly confirmed file Move

Development and release builds use pinned libmtp 1.1.23 and libusb 1.0.30 sources prepared by `scripts/build-native-deps.sh`. Release jobs build each architecture natively with `MACOSX_DEPLOYMENT_TARGET=12.0`. The native build script copies `libmtp.9.dylib` and `libusb-1.0.0.dylib` into `resources/lib`, rewrites Mach-O install names to `@loader_path`, and the macOS package copies that directory into `Contents/Resources/lib`. Packaged code is checked for the correct architecture, macOS deployment target, and absence of Homebrew or local build paths.

Packaging also uses project-owned icon artwork from `build/app-icon.svg`, rendered to `build/icon.icns` and configured as the macOS app icon. This keeps local builds from shipping with Electron's default icon or OpenMTP branding.

Public release jobs sign nested native binaries first, sign and notarize the outer app, staple the app, build and sign the DMG, notarize and staple the DMG, then mount and reassess the final artifact. A draft GitHub release is published only after the uploaded assets are downloaded and the same checksum, signature, stapling, architecture, deployment-target, and Gatekeeper checks pass again.
