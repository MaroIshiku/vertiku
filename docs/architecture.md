# Architecture

Vertiku is a Node.js 24 application with a Fastify HTTP boundary, React client, SQLite persistence through the Drizzle node-sqlite adapter, and local FFmpeg/ffprobe adapter processes. The server owns every upload, working-result, and published-output path; browser input never becomes a command or filesystem path. Read-only `/input` sources are referenced in place. Default results are encoded and validated as hidden partial files on the `/output` filesystem, then published without byte copying through an exclusive hard link. Browser-download results remain in private `/data` storage.

The first milestone uses an in-process bounded FIFO scheduler backed by SQLite. All conversion parameters and source references persist before enqueueing, interrupted running jobs are returned to `queued` at startup, and progress is streamed with server-sent events. The default concurrency is one and can be raised to eight. A later worker split can keep the same claim-and-adapter contract without changing the browser contract.

Trust boundaries are the browser/session boundary, multipart upload parser, read-only `/input` mount, persistent media directories, SQLite database, and FFmpeg process. Account ID is included in every draft, job, and artifact lookup. Mounted folder identifiers are canonicalized below the configured root, and directory traversal does not follow symlinks.
