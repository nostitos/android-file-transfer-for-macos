# Android File Transfer for macOS v0.2.0

The second public pre-release. It adds phone and Mac file management, explicit same-name conflict handling, and a connection flow that opens the phone on its own and explains clearly when it cannot.

## Added

- Rename phone files and folders, and permanently delete selected phone items after a native confirmation. Every rename and delete re-verifies the object's ID, storage, parent, kind, name, and size immediately before changing it.
- Create folders, rename items, and delete in the Mac pane. Mac delete moves items to the recoverable macOS Trash.
- Same-name transfers offer Keep Both, Replace, Skip Existing, or Cancel. Mac replacement is atomic; phone replacement uploads under a temporary name and keeps the old file under a backup name until the new one is verified.
- Independent list and grid views, hidden-file toggles, and selection summaries in each pane.
- Right-click context menus and shift-click range selection in both panes.
- A daily check of the project's GitHub Releases that shows a compact Update action only when a newer version exists, plus Help > Check for Updates for an immediate answer.
- Automatic opening of one MTP session when File Transfer appears, reused for browsing and copying.
- Destination free-space checks before a copy to the Mac, and preserved phone modified dates on downloaded files and folders.

## Fixed

- The waiting screen no longer rewrites itself while the app rechecks the phone. A background recheck used to swap the heading between "Connected. Reading phone storage..." and "Waiting for your phone to share its files..." about twice a second.
- A phone left on Charging / No data transfer is now described accurately. Samsung devices still expose an MTP interface in that mode, so the session opens but no storage is ever shared; the app now says to choose File transfer instead of suggesting a prompt that never appears.
- The storage question is repeated at most every two seconds instead of on every 400 ms USB check, and repeated identical log lines are summarized every 30 seconds.
- When a Mac app holds the phone through macOS Image Capture, the app names it. `ptpcamerad` reconnects on that app's behalf and resets the phone each time, which stops the phone answering anyone; the gate now reads "Quit <app> to free your phone" instead of retrying silently.

Both DMGs and their contained apps are Developer ID signed, Apple-notarized, stapled, and independently checked after upload. Verify downloads with `SHA256SUMS.txt`.

Real-device validation remains deepest on Samsung MTP behavior; reports from other Android devices and macOS versions are especially useful.
