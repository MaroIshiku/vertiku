# Contributing

Use Node.js 24, keep all interface text in English, and run `npm run check` plus `node .ishiku/kit/scripts/verify-app . --full` before opening a pull request. Add deterministic synthetic media fixtures only; never commit personal audio, databases, secrets, or generated result files.

Conversion adapters must build fixed argument arrays, set `shell: false`, validate their output, and include negative security tests. Do not add remote URL import, yt-dlp, Pulliku coupling, DRM bypass, silence detection, transcription, or online chapter lookup.
