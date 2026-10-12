## Which download should I use?

| Your device | Download | Notes |
| --- | --- | --- |
| **Windows** | `…-setup.exe` | **Recommended.** Installs for your Windows account, usually needs no administrator access, and is the installer in-app updates use. |
| **Windows, managed PCs** | `….msi` | For administrators: Group Policy, Intune, or a machine-wide install. Usually needs administrator access. |
| **Mac, Apple Silicon** (M1 and newer) | `…aarch64.dmg` | Open the disk image and drag the app to Applications. |
| **Android** | `.apk` | Download it on the phone (or copy it over USB) and tap to install. Allow "Install unknown apps" for your browser or file manager when asked. |
| **iPhone / iPad** | `.ipa` | Add the `sidestore-source.json` URL as a SideStore source, or download the `.ipa` and install it through SideStore. |

### First launch: expect a security warning

These downloads are not signed with a paid Apple or Microsoft developer certificate, so both systems warn the first time you open the app. The warning is expected. Updates you install from inside the app are verified by the app's own signature and do not repeat it.

- **Windows:** if "Windows protected your PC" appears, choose **More info**, then **Run anyway**.
- **macOS:** if macOS says the app cannot be opened because it is from an unidentified developer, open **System Settings → Privacy & Security**, scroll to the message about the app, and choose **Open Anyway**. On macOS 14 and earlier you can instead right-click the app and choose **Open**.

### Files you do not need to download

Files ending in `.sig`, `.sha256`, `.tar.gz`, and `latest.json` are used by automatic updates and for checking downloads. They are not installers.
