# Changelog

## 0.1.1 - 2026-08-10

### Security

- Added explicit rate limits to readiness, upload, mounted-input, job creation, and artifact download routes.
- Updated the pinned runtime base, removed unused package managers and Perl from the final image, and documented non-reachable cJSON findings with OpenVEX.
- Raised the setup-secret minimum to 32 characters and reject the published Compose placeholder at startup.

### Changed

- Replaced the source-build Compose setup with a ZimaOS-first GHCR deployment, editable in-file setup secret, fixed port `8514`, standard appliance paths, bind-mount permission initialization, resource and log bounds, and CasaOS/ZimaOS metadata.
- Added an appliance-tag workflow that promotes a successfully released image digest to `latest` without rebuilding it.

## 0.1.0 - 2026-08-10

### Added

- First-run administrator setup and revocable session authentication.
- Private multi-audio upload plus read-only, zero-copy `/input` discovery with ffprobe analysis and natural sorting.
- Editable file-based chapter order, chapter titles, metadata, cover, and AAC quality.
- Persistent bounded FIFO queue with restart recovery, queue position, live progress, and cancellation.
- Safe FFmpeg M4B conversion, no-copy `/output` publication, authenticated browser download, validation, and history.
- Responsive six-theme interface, hardened container delivery, documentation, and verification scaffolding.
