# Backup, restore, and upgrade

Stop Vertiku, then back up the complete `/data` volume. It contains the SQLite database, active browser uploads, and retained browser-download results; default `/output` results live on the separate output mount. Restore by starting the same or a compatible image against a restored copy of `/data` and the matching `/output` backup.

Before upgrading, create and test a backup, record the current image digest, and retain that image for rollback. Roll back by stopping the new image and starting the recorded image against the pre-upgrade data backup. Never copy a live SQLite database without a coordinated snapshot.
