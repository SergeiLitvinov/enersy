# Spatial index baseline

`spatial-index-sorted.ts` is the Enersy BVH implementation captured before the
2026-10-21 construction optimization. It is an intentional benchmark reference,
not production code or an alternative application backend. Do not import it
from `src/` or update it alongside the optimized implementation.

SHA-256 with LF line endings:
`2e696ccef5172fa2a48b8ece43897928d6e42232770bedb775047fb8f95c5204`.

The documented Docker control run mounts this file over the container's
`src/domain/spatial-index.ts` without replacing the working-tree source. This
isolates the builder comparison while keeping the current picker, snapshot
release fix, fixture and profiler identical. Results and limitations are in
`docs/site/development/editor-performance.md`.
