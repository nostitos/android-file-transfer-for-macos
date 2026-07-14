# Manual Test Checklist

Use a real Android phone connected over USB. Samsung Galaxy S24-class devices, including SM-S928W-style behavior, are a priority test target.

## Setup

- Install prerequisites: `brew install libmtp pkg-config`.
- Run `npm install`.
- Run `npm run dev`.
- For packaged builds, confirm the app icon is not the default Electron icon.
- During startup, confirm the window never stays blank white; if loading fails, it should show a plain startup or display-problem message with recovery actions.
- Connect the phone by USB.
- Unlock the phone.
- Choose File Transfer / Android Auto from the Android USB notification.

## Acceptance Flow

- The app changes from no-device to connected without restarting.
- A recognizable device name or raw USB product appears in the sidebar.
- If two phones are connected, both appear under Phones; select each phone and confirm its Storage list and folder navigation reset to that phone.
- Confirm the sidebar does not show raw helper/log paths until Details is clicked.
- Click Details and confirm technical helper/log paths and stderr are available without replacing the plain-language connection guidance.
- In Details, click Copy Report and confirm the app says the connection report was copied. Paste it into a text editor and confirm it includes status, raw USB metadata, USB session identity when macOS reports it, helper/log paths, session state, and the privacy note, but not phone folder listings.
- While the phone is blocked, wait at least 3 seconds and confirm the app checks again without clicking anything.
- Confirm automatic checks do not add a persistent last-check timestamp or spinner to the sidebar.
- In no-phone and wrong-USB-mode states, confirm the main panel says there is no need to refresh instead of pushing a manual refresh button.
- Click Check now from the sidebar or USB-visible/file-session-not-open panel; confirm Check now feedback appears once, stays short, and is not duplicated above the main help panel.
- Internal storage appears in the Storage list.
- Storage rows show the full readable storage name, used/free capacity text, and a compact usage meter when capacity metadata is available.
- Opening internal storage shows root folders in the compact table.
- If Internal storage opens but libmtp returns no root folders, confirm the app shows a retryable folder error instead of silently saying the phone has no items.
- Breadcrumb, back, forward, and up navigation work.
- Click the phone table, use Up/Down to move selection, Enter/Right Arrow to open a folder, Left Arrow or Cmd/Ctrl+B to go up, Cmd/Ctrl+1 to focus the phone pane, Cmd/Ctrl+2 to focus the Mac pane, Cmd/Ctrl+A to select visible rows, Cmd/Ctrl+F to focus Filter, Cmd/Ctrl+R to check the phone now, Cmd/Ctrl+N to open New Folder, Cmd/Ctrl+C then Cmd/Ctrl+V to queue the selected phone files/folders to the Mac pane, and Cmd/Ctrl+Shift+C or Cmd/Ctrl+Enter to queue them immediately.
- With no file or folder selected, press Cmd/Ctrl+C and Cmd/Ctrl+Shift+C; confirm nothing happens and no transfer warning appears.
- In phone grid view, confirm Arrow Left/Right move by tile, Arrow Up/Down move by one grid row, Shift+Arrow extends selection, and Enter opens the selected tile.
- Click the Mac pane, use Up/Down to move selection, Enter/Right Arrow to open a folder, Left Arrow or Cmd/Ctrl+B to go to the parent folder, Cmd/Ctrl+A to select visible Mac items, Cmd/Ctrl+C then Cmd/Ctrl+V to queue selected Mac items to the open phone folder, and Cmd/Ctrl+Shift+C or Cmd/Ctrl+Enter to copy the selected Mac items immediately.
- In the phone table or grid, Cmd/Ctrl-click two separated rows to toggle them, then Shift-click another row and confirm the visible range from the last anchor is selected.
- In the Mac pane, Cmd/Ctrl-click two separated rows to toggle them, then Shift-click another row and confirm the visible range from the last anchor is selected.
- Select one or more phone files/folders and confirm the phone summary strip keeps the folder total visible while the selected-item summary shows item count, file count, selected file size, and the next safe actions.
- Select one or more Mac files/folders and confirm the Mac action strip shows the selected-item summary with file size and explains whether Copy to Phone is available.
- Right-click a phone file and confirm the menu offers Copy to Mac and Move to the named Mac folder without a separate preparation command. For a folder selection, confirm Move is disabled while Copy remains available.
- Right-click a Mac file and confirm the menu offers Copy to Phone, Move to the named phone folder, and Reveal in Finder. For a folder selection, confirm Move is disabled while Copy remains available; folders also offer Open Folder.
- Right-click empty space in each pane and confirm pane-level actions such as Check Phone Now, Refresh Mac Folder, Parent Folder, Choose Mac Folder, and New Phone Folder are understandable and enabled only when valid.
- From the macOS menu bar, confirm File > New Folder, File > Check Phone Now, Edit > Copy File Selection, Edit > Paste File Selection, Edit > Copy to Queue, View > Folder Up, View > Focus Phone Pane, View > Focus Mac Pane, View > List/Grid View, View > Show/Hide Hidden Files, View > Light/Dark/System Appearance, File/Help > Open Log, and File > Open Phone Files trigger the same app actions as the toolbar or shortcuts.
- Use the title-bar appearance control to switch between light, system, and dark modes; confirm tables, queue cards, dialogs, and connection help remain readable.
- Use the hidden files toolbar button or View menu item; confirm dotfiles and dotfolders are hidden by default and become visible in both the phone pane and Mac pane when enabled.
- Opening `DCIM` or `Movies` shows files in rows, not oversized cards.
- After a folder finishes listing, confirm the phone pane shows a compact summary with folder count, file count, and total file size.
- Confirm the phone pane says that clicking selects, double-clicking opens folders, and files/folders can be dragged directly to a destination.
- While a large folder is listing, confirm the banner shows elapsed time and a real percentage when the phone reports `sent/total`; otherwise it keeps the indeterminate bar. Click Stop, confirm the spinner stops and the app says listing stopped, then confirm Retry starts only that folder again.
- Use the phone toolbar view control to switch from List to Grid; confirm grid tiles show icon, name, type or size, modified date, selection, double-click open, and the same direct drag flow.
- Confirm both transfer strips show Copy/Move as a segmented mode and an arrow that points at the named destination folder. Resize the window and confirm the destination remains understandable.
- Select one phone file, choose Move, and confirm the native warning explains that the app copies and verifies first, deletes only the source, and keeps the source on failure. Cancel and confirm nothing changes.
- Move one disposable phone file to the Mac. Confirm the destination completes before the source disappears, the queue says `moved`, and the phone folder refreshes. Force a phone deletion failure when practical and confirm the queue says `copied; source kept` without offering a duplicate-producing retry.
- Move one disposable Mac file to the phone. Confirm the phone reports the exact uploaded object with a matching name and size before the unchanged local source is deleted. Modify or replace the local source while a large move is copying and confirm the destination copy remains but the changed source is kept.
- Confirm Move is unavailable for folders in both directions; Copy must continue to handle folders recursively.
- Switch back to List and confirm the dense table is still the default after clearing the stored app data or using a fresh profile.
- Name, Size, Modified, and Type columns are visible.
- Sorting works for Name, Size, Modified, and Type.
- File sizes are visible for videos and other files.
- Choose a Mac destination folder.
- If a test Mac volume or folder has too little free space for a selected phone file, confirm the queue says not enough free space, explains to choose another Mac folder or free space, and Retry re-checks instead of starting the copy.
- The Mac pane starts at the user Home folder, showing common folders such as Documents and Downloads as a full right-side file browser, not a tiny widget.
- Confirm the Mac pane shows shortcut buttons for Home, Downloads, Documents, Pictures, Movies, and Desktop, and that each shortcut opens that folder through the same file list.
- Confirm the Mac pane shows Finder-style Name, Modified, Kind, and Size columns and enough vertical space to scan a folder.
- In the Mac pane, open a folder, then use Back, Forward, Up, and a breadcrumb segment to confirm local navigation works like a normal file browser.
- Click the Mac pane Name, Modified, Kind, and Size headers; confirm rows sort by that column and a second click reverses the direction without breaking selection.
- Drag the divider between the phone table and the Mac pane left/right; confirm the Mac pane resizes, the phone table remains usable, and the width is remembered after relaunch.
- Focus the divider and use Arrow Left/Right, Shift+Arrow, Home, and End; confirm the Mac pane resizes without mouse input.
- Drag a file or folder row from the Mac pane to Desktop/Finder and confirm macOS treats it as a normal file/folder drag.
- Open Internal storage and create a New Folder; confirm the folder appears in the phone table.
- First select a file already visible in `DCIM` and click Copy to Mac.
- After the copy finishes, reveal the file in Finder and confirm its modified date matches the phone row instead of the copy time.
- Copy the same phone file to the same Mac folder twice; confirm the second queue row says it was saved with a new Mac name and that nothing was overwritten.
- Move the pointer over phone rows, select rows, and scroll; confirm this starts no transfer or folder scan.
- Start dragging a phone file, then cancel without dropping; confirm no queue job appears and no USB file data moves.
- Drag a visible phone file to Desktop or Finder; confirm the native drag starts immediately, the queue begins only after the drop, exactly one MTP copy runs, and no `.textClipping` file appears.
- Drag a large phone file to a destination volume with too little space; confirm the promise fails without a visible partial file and tells the user to free space and drag again.
- Drag a phone file into the app's Mac pane and confirm it copies directly into the currently displayed Mac folder.
- Select a small phone folder and click Copy to Mac; confirm the queue contains the files inside the folder under a matching Mac folder.
- While that folder copy is being planned, confirm the queue pane shows Preparing folder copy with an indeterminate progress bar and live file/folder counts before normal transfer jobs appear.
- During folder copy preparation, click Stop; confirm the Preparing card disappears, the app says Nothing was copied, and no transfer jobs are queued.
- After a copied phone folder finishes, reveal it in Finder and confirm the folder modified date matches the phone row after child copies finish.
- Copy or drag an empty phone folder to the Mac and confirm an empty Mac folder is created instead of a no-files error.
- For an empty phone folder, confirm the created Mac folder's modified date matches the phone row.
- Drag a phone folder to Desktop, Finder, or another compatible Mac app; confirm folder listing starts only after the drop, then child files copy directly into the promised folder.
- Select a file in the Mac pane and click Copy to Phone while a phone folder is open.
- Select a small folder in the Mac pane and click Copy to Phone; confirm the folder appears on the phone and its files queue as `to phone` with progress.
- Open a writable phone folder, drag one small Mac file from Finder into the phone table, and confirm it queues as `to phone` with progress.
- Drag one small Mac folder from Finder into the phone table; confirm the phone folder is created and child files queue as `to phone`.
- Copy or drop a Mac file that already exists on the phone with the same name and size; confirm the app reports a name conflict rather than assuming the bytes are identical.
- Copy or drop a same-name Mac file whose size differs from the phone file; confirm the app reports the same non-destructive name conflict.
- Retry a canceled or failed Mac-to-phone upload after a same-name file appears on the phone; confirm the native preflight still reports a conflict and nothing is overwritten.
- Confirm dropping a Mac file or folder at the device root explains that Internal storage or a phone folder must be opened first.
- After the first copy succeeds, test a larger video. If a 4GB+ video is available, use it to confirm the copy keeps running while progress updates continue.
- Progress, speed, ETA, completed state, and destination are visible in the queue.
- The queue summary shows overall percent, copied-of-total bytes, active speed, ETA, and counts for done/failed/canceled items.
- While folder planning or a copy is queued or active, the top status pill changes from Connected/Files open to Preparing, Transfer queued, or Transferring.
- Reveal in Finder opens the copied file location.
- Queue two or more copies, click Cancel All, and confirm queued/active jobs become canceled without another password prompt.
- Click Clear Finished after completed/canceled/failed jobs exist; finished items are removed while active or queued jobs remain.
- Start a large copy and cancel it; the queue shows canceled and the log shows the protected or normal worker was stopped.
- Quit the app after a normal phone-file session is open; confirm the log says `sent graceful quit to MTP session` instead of immediately killing the helper with `SIGTERM`.
- Retry the canceled or failed copy; it queues again.
- Unplug the phone; the app reports the disconnected/no-device state.
- Plug the phone back in; the app recovers after automatic checking or Check now without app restart.
- If the app says the phone is visible but files are not open yet, click Open files.
- Confirm the connection-stage strip shows Cable and File transfer as done, Open files as the current step, and Storage/Folder list as waiting.
- Confirm the sidebar also shows a compact Open files button in that USB-visible/file-session-not-open state, and that the long explanation appears only in the main recovery panel.
- For a Samsung phone visible as `04e8:6860`, confirm the app treats it as File Transfer/MTP visible and does not tell the user to change USB mode first.
- If Details shows `Mac USB protection` as required and `File session` says it is not open, confirm the main panel says the phone is visible in File Transfer mode but the folders are not open in this app yet.
- After unplug/replug, confirm `USB session` changes in Details or Copy Report, the old protected session is not reused, and stale storage or folder errors clear for the new session. If Phone storage is inferred and normal root listing fails, confirm the app loads the Samsung fallback once, reports listing progress, and reuses that index for later folders.
- Confirm the app first explains why the Mac password prompt appears.
- In the macOS password prompt, confirm the copy explains that `osascript wants to make changes` is the system prompt for the protected file session.
- Cancel the macOS password prompt once; the app should say Open files was canceled and not show a technical `osascript` error.
- After approving Open files, confirm the phone storage row appears and later folder listing/copying uses the same protected session instead of repeatedly reopening the failed USB address.
- Leave the phone connected for at least 30 seconds after Open files succeeds; confirm the file browser stays open even if the status checker briefly loses the raw USB device.
- Quit and relaunch the app while the protected session is idle; within the reconnect window, confirm startup status reattaches to the protected session, inventory opens automatically, and no second Mac password prompt or extra Open files click is required, even if the Samsung raw USB bus/address changed but the same phone is still visible.
- During a protected large copy, cancel once and confirm the log records the protected session runner being signaled or stopped.

## Failure-State Checks

- Phone locked or waiting for Android permission: app should show Unlock phone or locked-phone guidance instead of an empty table, and it should tell the user to tap Allow if Android asks.
- Charge-only USB mode: app should show no-device or connect-error guidance.
- Missing helper: temporarily rename `resources/bin/mtp-json`; app should show bridge-missing guidance.
- No build-time `libmtp`: the native build should fail clearly. A packaged app should still load its bundled `libmtp` and `libusb` dylibs.

## Samsung Session-Open Regression

Samsung devices may remain visible to IOKit in File Transfer mode while libmtp returns `PTP_ERROR_IO` before opening a file session. Validate this as a distinct state rather than treating USB detection as readable storage:

- `mtp-json status` returns the visible MTP device through its IOKit fallback instead of reporting `no-device`.
- The app says the USB device is visible but its folders are not open, and offers **Open files**.
- Protected-open retries wait through the reset/reclaim window without terminating Photos, Image Capture, or system camera/import services.
- The elevated runner opens USB, then drops to the logged-in uid, gid, and supplementary groups before accepting file commands.
- A failed open never implies storage or file listings were available.
- Automatic polling tries once for the same visible attachment, then stops prompting until Check now, Open files, a USB-mode change, or a real reconnect.
- Raw bus/address or product-label churn does not close an active session or restart Android's Allow prompt loop.
- A changed USB session ID clears stale inventory, folder errors, and automatic-open blocking.
- After the browser opens, leave it connected for at least 30 seconds and confirm transient status probes do not replace the working folder view.

For a large-file smoke test, use a non-private test file already intended for transfer:

```sh
npm run mtp:smoke -- --timeout-ms=300000 --min-size=10000000
```

## Non-Goals For v1

- Do not test phone-side delete, rename, or move; those actions are intentionally absent.
- Do not require Wi-Fi, cloud sync, adb, or an Android companion app.
