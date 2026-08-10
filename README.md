# Vertiku

## Short description

Vertiku is a calm, self-hosted file conversion workspace. The first milestone is a complete audiobook converter: choose an audiobook folder from a read-only `/input` mount or upload local audio files, review their naturally sorted chapter order, edit chapter titles and book metadata, add a cover, create a validated M4B, and download it.

## Screenshots

The interface is mobile-first and expands into a focused desktop workspace. Screenshots will be added after the first visual baseline is approved.

## Features

- One input file becomes exactly one M4B chapter.
- Every audio-containing folder below the read-only `/input` mount is treated as a separate audiobook.
- Natural filename order puts `Part 2` before `Part 10`.
- Editable chapter order, titles, book metadata, cover, and quality preset.
- A persistent FIFO conversion queue with configurable worker concurrency, live progress, cancellation, restart recovery, job history, and owner-only downloads.
- Runtime validation of duration, chapter count, chapter titles, and title metadata.
- One-time administrator setup, Argon2id passwords, revocable sessions, and CSRF protection.
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

The published Compose file pulls `ghcr.io/maroishiku/vertiku:latest` directly so ZimaOS does not need variable interpolation. To pin a deployment, replace both image values with the same version tag or immutable digest. Open `http://localhost:8514`, complete first-run setup with the configured secret, then remove the `ISHIKU_SETUP_SECRET` line from the deployment after the administrator exists.

### ZimaOS

In ZimaOS 1.7 or newer, choose **Install a customized app**, open the YAML import, and paste the complete [`compose.yaml`](compose.yaml). Before installing, replace `REPLACE-WITH-A-UNIQUE-SECRET-OF-AT-LEAST-32-CHARACTERS` with your own random value directly in the Compose editor. Vertiku deliberately rejects the published placeholder. The primary Compose contains direct scalar values and no `${...}` variables, `.env` dependency, or source build. Port `8514` must be free.

The ZimaOS-ready defaults use these host folders:

- `/DATA/AppData/i_vertiku/Data` for the database and private application data
- `/DATA/AppData/i_vertiku/Input` for read-only source folders
- `/DATA/AppData/i_vertiku/Output` for converted M4B files

Each folder directly below the input path is treated as a separate audiobook. The short-lived `vertiku-permissions` helper only assigns the data and output mount roots to the unprivileged application user; the Vertiku service itself still runs as the image's non-root `node` user.

## Volumes and folders

`/data` is persistent and contains the database plus upload/browser-download storage. `/input` is a read-only source mount; Vertiku references those files in place and never moves, copies, or deletes them. `/output` is the default read-write destination. Vertiku encodes to a hidden partial file inside `/output`, validates it, and publishes it through a same-filesystem hard link, so no second 1 GB result is created in `/data`. Existing output files are never overwritten; Vertiku appends a counter. Uploaded source files are deleted from private application storage after a terminal job. The container root is read-only and `/tmp` is a size-bounded temporary filesystem.

## Environment variables

See [.env.example](.env.example) for local development or an optional external-environment deployment. For Docker Compose or Portainer, copy it to the ignored `.env` file and replace the `environment:` mapping in a separate local Compose variant with `env_file: [.env]`. Important values are `ISHIKU_SETUP_SECRET`, `VERTIKU_DATA_DIR`, `VERTIKU_DATABASE_URL`, `VERTIKU_MAX_UPLOAD_GIB`, `VERTIKU_MAX_CONCURRENT_JOBS`, and `VERTIKU_COOKIE_SECURE`. Existing deployments may continue to use the legacy `VERTIKU_SETUP_SECRET` name. The primary ZimaOS `compose.yaml` always uses direct values instead.

## Workers and engines

This milestone runs a local FFmpeg adapter in the core container. FFmpeg and ffprobe are discovered at runtime. Browser input cannot select commands, executable paths, codecs, filters, or arbitrary arguments. A later worker split can preserve the adapter boundary and dynamic capability model.

## M4B workflow

1. Select an audiobook folder below `/input`, or select/drop local audio files and optionally add a cover.
2. Vertiku probes and naturally sorts the files. Browser uploads are stored once until their job ends; `/input` files are referenced in place without an application-side copy.
3. Review the exact chapter order and edit every title.
4. Add book metadata and choose 64, 96, or 128 kbps AAC.
5. Keep the default `/output` destination or choose an authenticated browser download.
6. Start the job. It enters the persistent FIFO queue (one worker by default), shows its position and live progress, and can be cancelled while queued or running.
7. Vertiku publishes or offers the M4B only after validation succeeds. Interrupted running jobs return to the queue after restart.

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
