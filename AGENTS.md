# Vertiku repository rules

Read `appspec.yaml`, `.ishiku/project.yaml`, applicable decisions/overrides, and the local skills before editing. This repository is clone-independent; never reference the outer workspace. Preserve data and compatibility, keep UI text English, update traceability, and run `node .ishiku/kit/scripts/verify-app . --full`. Report only `BLOCKED`, `IMPLEMENTED_BUT_NOT_VERIFIED`, or `VERIFIED` with evidence.
