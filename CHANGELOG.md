# Changelog

## 0.1.3 - 2026-08-10

### Fixed

- Stopped the HTTP ZimaOS deployment from upgrading its own browser assets to unavailable HTTPS URLs, which caused a blank page while the API remained healthy.
- Preserved `upgrade-insecure-requests` for deployments that explicitly enable secure-cookie HTTPS mode.
- Replaced the completed permissions helper service with an in-service ownership bootstrap so ZimaOS no longer remains in an installing state; the application process still runs as UID/GID 1000 with an empty capability set.

## 0.1.2 - 2026-08-10

### Changed

- Replaced every interpolation variable in the primary ZimaOS Compose file with a direct scalar value so ZimaOS can import it without `.env` processing.
- Kept the setup-secret placeholder directly editable in Compose and documented direct image pinning as an optional manual change.

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
