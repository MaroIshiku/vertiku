# Backup, restore, and upgrade

Stop Vertiku, then back up the complete `/data` volume. It contains the SQLite database, active browser uploads, and retained browser-download results; default `/output` results live on the separate output mount. Restore by starting the same or a compatible image against a restored copy of `/data` and the matching `/output` backup.

Before upgrading, create and test a backup, record the current image digest, and retain that image for rollback. Roll back by stopping the new image and starting the recorded image against the pre-upgrade data backup. Never copy a live SQLite database without a coordinated snapshot.

Versions 0.3.0 and 0.4.0 add columns and an audit table through additive, idempotent SQLite migration statements. Version 0.4.0 adds only the persisted job phase and does not rewrite media or existing rows beyond the safe default. Rolling back to an older image must use the pre-upgrade `/data` backup even though older code normally ignores the additional columns.
