# Changelog

## Unreleased

### Fixed

- Concurrent first-run setup requests can no longer create more than one administrator account.
- Signing out with secure cookies now actually expires the `__Host-` session cookie in the browser.
- Audiobook titles with many multi-byte characters no longer fail at publication after a complete encode; generated filenames stay within the 255-byte filesystem limit including collision suffixes, and leading dots no longer create hidden files.
- Cancelling a job while its sources are inspected or its output is prepared no longer starts a full encode; cancelled running jobs record their finish time and remove their private upload copy like cancelled waiting jobs.
- Byte-range requests for `bytes=-0` are rejected as unsatisfiable instead of returning the first byte.
- FFmpeg progress lines split across output chunks no longer make the progress bar jump backwards.
- Upload size-limit failures return the intended 413 response, and uploads with a generic browser MIME type (for example some Opus or FLAC files) are accepted when the extension is allowlisted; ffprobe remains the authoritative check.
- The browser no longer hangs on upload when a proxy answers with a non-JSON error, shows errors for every job action, offers a retry when the server is unreachable at startup, and returns to sign-in with a notice when the session has expired.
- Unsupported files added in the upload view are reported instead of silently dropped.

### Changed

- Readiness now reports `storage: failed` with HTTP 503 when the data, upload, or result directories are not writable.
- Vertiku shuts down gracefully on `SIGTERM`/`SIGINT`: live-update streams are closed, FFmpeg is stopped, the running job is requeued, and SQLite is closed before exit.
- Live-update streams send keep-alive comments, survive transient update errors without crashing the process, and resolve queue positions with one query per snapshot instead of one query per waiting job.
- The About view and `/api/manifest` report the version from `package.json` instead of a hard-coded value.
- Job details offer an "All jobs" shortcut; the profile dialog closes with Escape, keeps keyboard focus inside, and returns focus to the profile button.

### Security

- Sign-in performs an Argon2id verification for unknown usernames as well, so response timing does not reveal which accounts exist.
- Upload and input-library analysis failures no longer return ffprobe diagnostics or container paths to the browser; the detail is logged server-side and the user sees the affected filename only.
- Successful first-run setup is recorded in the audit log.

## 0.5.2 - 2026-08-11

### Changed

- Stabilized release verification for the complete SQLite upgrade-and-forecast migration test on slower hosted runners without changing its assertions or application behavior.

## 0.5.1 - 2026-08-11

### Fixed

- Preserve the exact filesystem casing of detected local cover files so `Cover.JPG`, `Folder.jpg`, and similar names work on case-sensitive ZimaOS filesystems.
- Recover already queued v0.5.0 cover references case-insensitively and continue with embedded artwork or no artwork when an optional cover was removed, instead of failing the audiobook.

### Security

- Runtime cover recovery accepts only regular files resolved below Vertiku's trusted read-only input or generated upload roots and does not expose source paths in warning logs.

## 0.5.0 - 2026-08-11

### Added

- Added owner-scoped actions to clear all failed and cancelled jobs or one terminal job from the overview without deleting source files, completed audiobooks, conversion results, or durable ETA samples.
- Added searchable short job references to concise conversion errors while retaining full structured diagnostics in the container log.

### Changed

- Replaced the all-input FFmpeg filter graph with a bounded sequential decoder-to-encoder PCM stream, so large chapter sets keep only one source decoder and one output encoder active without creating a second full-size audiobook copy.
- Reduced FFmpeg output to actual engine errors and record the job ID, phase, progress, source count, and failure code in structured logs.

### Fixed

- Fixed immediate FFmpeg failures for audiobooks containing tens or hundreds of MP3 source files, including sources with embedded cover art.
- Archived jobs no longer appear in live updates, direct job details, or retry actions.

### Security

- Job-history mutations require an authenticated owner session and valid CSRF proof; archiving is additive and non-destructive.
- Detailed engine diagnostics are no longer returned through the authenticated jobs API or rendered in the browser UI.

## 0.4.3 - 2026-08-11

### Fixed

- Made Compose-gated password recovery tolerate surrounding whitespace, accidentally copied YAML quote pairs, and Unicode compatibility forms for the existing username and secret.
- Store audiobook descriptions only in the dedicated description metadata field and no longer emit a duplicate `comment` tag.

### Security

- Recovery still requires the existing logical username and current setup secret, remains rate-limited and one-use, returns generic denials, revokes every session, and rejects reusing the setup secret as the new password across all accepted copy forms.

## 0.4.2 - 2026-08-10

### Added

- Added a confirmed jobs-overview action that atomically cancels all waiting audiobooks while the current conversion continues unchanged.

### Security

- The bulk cancellation mutation is owner-scoped, requires a valid session and CSRF proof, and never targets a running job.

## 0.4.1 - 2026-08-10

### Added

- Added durable conversion-performance samples that remain useful when audiobook files no longer exist.
- Added the one-use-per-value `VERTIKU_ETA_HISTORY_RESET_TOKEN` Compose control for recalibration after a hardware change.

### Fixed

- Replaced the optimistic full-queue ETA with source-byte projection, exact-duration evidence where available, a conservative historical percentile, and a minimum contribution from every queued audiobook.
- Normalized accidental setup-secret copy whitespace during password recovery and added non-secret server diagnostics while retaining the same generic client denial.

### Security

- Recovery remains disabled by default, rate-limited, one-use per process start, generic to clients, fully session-revoking, and free of credential material in audit records and logs.

## 0.4.0 - 2026-08-10

### Added

- Added a persistent five-step checklist to every job detail: queued, reading source details, preparing output, encoding audio, and validating/publishing.
- Added a per-job remaining-time estimate for the running audiobook and an explicitly scoped completion estimate for the entire active queue.

### Changed

- Job phases now come from persisted worker state instead of being inferred from a percentage threshold.
- Queue estimates now report the running audiobook and every waiting audiobook separately, while retaining the learned server-confidence label.

## 0.3.0 - 2026-08-10

### Added

- Added review-by-exception preflight, fast source fingerprints, duplicate and collision warnings, destination-capacity checks, and learned queue finish estimates.
- Added owner-scoped retry jobs that preserve the failed attempt and retained source while the serial queue continues.
- Added embedded metadata and cover reuse plus authenticated byte-range playback for completed validated M4B results.
- Added a disabled-by-default, one-use-per-start Compose password-recovery mode requiring the existing username and setup secret.

### Changed

- Batch review now focuses on deterministic output filenames, quality, destination, and chapter titles without requiring users to enter missing descriptive metadata.
- Removed the full-result memory read after validation so large M4B files are not loaded into Node.js memory.

### Security

- Password recovery is rate-limited, returns generic failures, audits outcomes without secrets, rehashes with Argon2id, and revokes all sessions.
- Media playback and retry routes repeat owner authorization; mutations require CSRF proof and range requests are strictly validated.

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
