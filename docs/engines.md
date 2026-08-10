# Engines

The first milestone requires FFmpeg and ffprobe. Vertiku probes every audio source, transcodes it to a consistent AAC stream, concatenates sources in the confirmed order, writes file-based chapters through FFmetadata, and validates duration, chapters, titles, and book title with ffprobe.

Engine commands use argument arrays and `shell: false`. The browser cannot supply executable paths, filter graphs, codecs, or arbitrary options. Supported formats depend on installed engines and codecs.
