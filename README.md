# Vertiku

## Short description

Vertiku is a calm, self-hosted file conversion workspace. The first milestone is a complete audiobook converter: choose an audiobook folder from a read-only `/input` mount or upload local audio files, review their naturally sorted chapter order, edit chapter titles and book metadata, add a cover, create a validated M4B, and download it.

## Screenshots

The interface is mobile-first and expands into a focused desktop workspace. Screenshots will be added after the first visual baseline is approved.

## Features

- One input file becomes exactly one M4B chapter.
- Every audio-containing folder below the read-only `/input` mount is treated as a separate audiobook.
- Natural filename order puts `Part 2` before `Part 10`.
- Repeated book names such as `001 - Drood.mp3` become distinct `Chapter 1`, `Chapter 2`, and later titles.
- Editable chapter order, titles, book metadata, cover, and quality preset.
- Select any number of `/input` books, including all of them, review them together, and enqueue the complete batch with one action.
- Review-by-exception preflight for chapter-number gaps, suspicious files, active or completed duplicates, output collisions, and destination capacity.
- A persistent strictly serial FIFO conversion queue with live progress, a five-step per-job checklist, separate current-book and full-queue finish estimates, individual cancellation, confirmed cancellation of all waiting books without stopping the active conversion, restart recovery, retryable failure history, and owner-only downloads.
- Existing embedded book metadata and cover art are reused; batch conversion never invents missing descriptive metadata.
- Completed validated results can be played through an authenticated native browser audio player.
- Runtime validation of duration, chapter count, chapter titles, and title metadata.
- One-time administrator setup, Argon2id passwords, revocable multi-device sessions, CSRF protection, and an explicitly Compose-gated one-use password recovery mode.
- Six ishiku themes with light, dark, and system appearance.

## Supported areas

The audiobook workflow accepts MP3, M4A, AAC, WAV, FLAC, OGG, and Opus. It creates AAC audio in an M4B container. Supported formats depend on installed engines and codecs.

Vertiku does not bypass DRM. Vertiku contains no yt-dlp in version 1. Vertiku is independent of Pulliku.

## Quick start

Requirements: Node.js 24, npm, FFmpeg, and ffprobe.

```bash
npm ci
ISHIKU_SETUP_SECRET='replace-with-at-least-32-random-characters' npm run dev
```

In another terminal, run `npm run dev:client` and open `http://localhost:5173`. For a production-style local run, use `npm run build && npm start` and open `http://localhost:8080`.

## Docker installation

```bash
# Edit ISHIKU_SETUP_SECRET in compose.yaml before the first start.
docker compose up -d
```

The published Compose file pulls `ghcr.io/maroishiku/vertiku:latest` directly so ZimaOS does not need variable interpolation. To pin a deployment, replace the image value with a version tag or immutable digest. Open `http://localhost:8514` and complete first-run setup with the configured secret. Use at least 32 random letters, digits, hyphens, or underscores for `ISHIKU_SETUP_SECRET`; avoiding `$` prevents Docker Compose from interpreting part of the value as a variable. Keep that secret configured and stored securely if you want Compose-gated password recovery to remain possible. A short ownership bootstrap runs as root at container start, then irrevocably drops to UID/GID 1000 with an empty capability set before the Vertiku process starts.

### ZimaOS

In ZimaOS 1.7 or newer, choose **Install a customized app**, open the YAML import, and paste the complete [`compose.yaml`](compose.yaml). Before installing, replace `REPLACE-WITH-A-UNIQUE-SECRET-OF-AT-LEAST-32-CHARACTERS` with your own random value directly in the Compose editor. Vertiku deliberately rejects the published placeholder. The primary Compose contains direct scalar values and no `${...}` variables, `.env` dependency, or source build. Port `8514` must be free.

The ZimaOS-ready defaults use these host folders:

- `/DATA/AppData/i_vertiku/Data` for the database and private application data
- `/DATA/AppData/i_vertiku/Input` for read-only source folders
- `/DATA/AppData/i_vertiku/Output` for converted M4B files

Each folder directly below the input path is treated as a separate audiobook. The single Vertiku service initializes the data and output mount ownership before dropping permanently to the unprivileged application user; no completed helper service remains for ZimaOS to track.

## Volumes and folders

`/data` is persistent and contains the database plus upload/browser-download storage. `/input` is a read-only source mount; Vertiku references those files in place and never moves, copies, or deletes them. `/output` is the default read-write destination. Vertiku encodes to a hidden partial file inside `/output`, validates it, and publishes it through a same-filesystem hard link, so no second 1 GB result is created in `/data`. Existing output files are never overwritten; Vertiku appends a counter. Uploaded source files are deleted after success or cancellation; a retryable failure retains its upload until a retry succeeds so recovery does not require another 1 GB upload. The container root is read-only and `/tmp` is a size-bounded temporary filesystem.

## Environment variables

See [.env.example](.env.example) for local development or an optional external-environment deployment. For Docker Compose or Portainer, copy it to the ignored `.env` file and replace the `environment:` mapping in a separate local Compose variant with `env_file: [.env]`. Important values are `ISHIKU_SETUP_SECRET`, `VERTIKU_PASSWORD_RESET`, `VERTIKU_ETA_HISTORY_RESET_TOKEN`, `VERTIKU_DATA_DIR`, `VERTIKU_DATABASE_URL`, `VERTIKU_MAX_UPLOAD_GIB`, and `VERTIKU_COOKIE_SECURE`. Existing deployments may continue to use the legacy `VERTIKU_SETUP_SECRET` name. The primary ZimaOS `compose.yaml` always uses direct values instead. Conversion concurrency is intentionally fixed at one so large books never compete for CPU, memory, or disk throughput.

### Password recovery

Recovery is disabled by default. If the existing administrator password is lost, set `VERTIKU_PASSWORD_RESET: "true"` directly in Compose and restart Vertiku. The sign-in page then exposes a recovery form that requires the existing username, the currently configured setup secret, and a new password of at least 12 characters. If an older secret contains `$` or its effective container value is uncertain, replace it with a new 32-character-or-longer value made from letters, digits, hyphens, and underscores before restarting; Compose-level access is already the recovery authority. A successful reset preserves the database, books, and jobs, revokes every existing session, and consumes recovery for that container start. Immediately return the value to `"false"` and restart Vertiku. Do not leave recovery enabled.

### Queue estimate history

Every successful conversion stores a small, durable performance measurement in SQLite. It contains byte count, audio duration, processing time, and timestamp—not audiobook content—and remains useful if the source or output file is later removed. The full-queue estimate uses a conservative percentile of these measurements and the sufficiently advanced active job, then projects every queued source byte. To discard measurements after moving the installation to materially different hardware, set `VERTIKU_ETA_HISTORY_RESET_TOKEN` to any new non-secret label such as `new-server-2026` and restart. Each distinct value resets once; leaving it unchanged across later restarts does not erase newly learned measurements.

## Workers and engines

This milestone runs a local FFmpeg adapter in the core container. FFmpeg and ffprobe are discovered at runtime. Browser input cannot select commands, executable paths, codecs, filters, or arbitrary arguments. A later worker split can preserve the adapter boundary and dynamic capability model.

## M4B workflow

1. Select one or more audiobook folders below `/input`—including **Select all**—or select/drop local audio files and optionally add a cover.
2. Vertiku probes and naturally sorts the files. Browser uploads are stored once until their job ends; `/input` files are referenced in place without an application-side copy.
3. Use the preflight status to select review-free books or inspect only exceptions. The compact batch review edits output filenames, quality, destination, and chapter titles without requiring descriptive metadata.
4. For a single book, optionally edit metadata. Existing embedded metadata and cover art are reused when no override is supplied.
5. Keep the default `/output` destination or choose an authenticated browser download.
6. Start one job or enqueue the complete batch. The persistent FIFO queue always runs exactly one audiobook at a time, keeps working without an open browser, shows a five-step job checklist, reports the current book separately from the complete queue ETA, and supports cancellation.
7. Vertiku publishes or offers the M4B only after validation succeeds. The native player becomes available at the same point. Interrupted running jobs return to the queue after restart, while retryable failures retain their attempt and can be queued again without blocking later books.

There is no silence detection, transcription, online chapter lookup, media URL input, or hidden multi-stage conversion.

## Security

Do not expose Vertiku directly to the internet. Put it behind HTTPS, keep the container and FFmpeg patched, use a random setup secret, and configure resource limits for your host. See [SECURITY.md](SECURITY.md) and [docs/security.md](docs/security.md).

## Updates and backups

Back up `/data` and `/output` before every upgrade, keep the previous image digest, and test restoration. Detailed steps are in [docs/backup-restore.md](docs/backup-restore.md).

## Part of the ishiku family

Vertiku follows the shared ishiku architecture, security, design, container, testing, and release policies while remaining a standalone application.

## Created with ChatGPT Codex

The initial implementation and project scaffolding were created collaboratively with ChatGPT Codex from the approved Vertiku AppSpec.

## Third-party components and licenses

Application dependencies retain their upstream licenses. The container installs Debian's FFmpeg build; codec and redistribution availability can vary. Review [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) before distribution.

## License

Vertiku application code is available under the MIT License. See [LICENSE](LICENSE).
