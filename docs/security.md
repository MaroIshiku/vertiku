# Security model

Assets are user passwords, setup authority, server sessions, uploaded audio, audiobook metadata, result files, and process/storage availability. Entry points are setup, sign-in, multipart upload, job creation/cancellation, event streams, and download.

Controls include one-time setup, Argon2id, generic sign-in failure, rate limits, hashed and revocable server sessions, HttpOnly SameSite cookies, CSRF proof, deny-by-default account filters, server-generated upload paths, canonicalized `/input` paths, rejected symlink traversal, read-only input mounts, upload allowlists, ffprobe validation, shell-free process spawning, CSP/security headers, error redaction, non-root containers, dropped capabilities, and read-only container roots.

Residual risk: media decoders process untrusted files. Keep the image and FFmpeg updated, set CPU/memory limits appropriate to the host, and do not expose Vertiku without HTTPS and a trusted reverse proxy.
