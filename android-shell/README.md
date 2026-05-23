# Android Shell

This module packages the existing React frontend into two Android APK flavors:

- `phone`: builds the `android` frontend target and packages it as `app-phone-release.apk`
- `pad`: builds the `android-pad` frontend target and packages it as `app-pad-release.apk`

The shell is a minimal WebView wrapper. During Gradle asset merging it runs the
frontend build for the matching target and copies `image-studio/frontend/dist/`
into `app/src/main/assets/web/`.

Current scope:

- APK packaging works from the WebView shell
- Frontend startup is supported by the Android-side `AndroidImageStudio` bridge
- Desktop-only backend features that still depend on the Go/Wails runtime are
  surfaced as explicit "not implemented in Android shell yet" errors

Local build:

```bash
cd android-shell
./gradlew assemblePhoneRelease
./gradlew assemblePadRelease
```
