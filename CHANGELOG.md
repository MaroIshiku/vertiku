# Changelog

## 0.2.0 - 2026-08-10

### Added

- Added select-all batch review for up to 100 read-only `/input` audiobooks and one-action persistent enqueueing.
- Added context-aware chapter inference that turns repeated numbered book filenames into distinct `Chapter N` titles and infers `Author - Title` folder metadata.
- Added an owner-scoped live jobs feed and automatic history refresh.

### Changed

- Fixed conversion concurrency at exactly one for predictable unattended processing of large audiobooks.
- Replaced the rotating working symbol with a reduced-motion-aware signal path that distinguishes queued, preparing, encoding, validating, and terminal states.

### Security

- Batch requests require CSRF proof, validate every folder and exact server-side filename set, reject duplicates or stale selections atomically, and store only references to the read-only input mount.

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
