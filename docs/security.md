# Security model

Assets are user passwords, setup authority, server sessions, uploaded audio, audiobook metadata, result files, and process/storage availability. Entry points are setup, sign-in, multipart upload, job creation/cancellation, event streams, and download.

Controls include one-time setup, a required non-placeholder setup secret of at least 32 characters, Argon2id, generic sign-in failure, route-specific limits on authentication and filesystem-backed requests, hashed and revocable server sessions, HttpOnly SameSite cookies, CSRF proof, deny-by-default account filters, server-generated upload paths, canonicalized `/input` paths, rejected symlink traversal, read-only input mounts, upload allowlists, ffprobe validation, shell-free process spawning, CSP/security headers, error redaction, non-root application containers, dropped capabilities, and read-only container roots. The ZimaOS Compose definition uses a network-disabled, one-shot helper with only `CAP_CHOWN` to initialize bind-mount ownership before the non-root application starts.

Residual risk: media decoders process untrusted files. Keep the image and FFmpeg updated, set CPU/memory limits appropriate to the host, and do not expose Vertiku without HTTPS and a trusted reverse proxy.

Container vulnerability assessments are recorded under [`.vex`](../.vex). A `not_affected` statement is used only when the vulnerable function is absent from Vertiku's execution path and the supporting dependency-symbol analysis is documented in the statement.
