# GLib 0.18 compatibility patch

This is the runtime source of upstream `glib` 0.18.5 (MIT), retained for the GTK3 ABI used by Tauri. Registry/build metadata, examples and integration tests are omitted. The normalized manifest keeps the original runtime dependencies and features; development-only targets/dependencies are omitted.

`src/variant_iter.rs`: backport the two-line mutable out-pointer fix from https://github.com/gtk-rs/gtk-rs-core/pull/1343 for https://rustsec.org/advisories/RUSTSEC-2024-0429.html. The version remains 0.18.5; it is not relabelled as 0.20. Cargo uses this path override for all GTK3 consumers. Remove the override when the upstream desktop stack supports a fixed GLib release.

Original registry checksum: `233daaf6e83ae6a12a52055f568f9d7cf4671dabb78ff9560ab6da230ce00ee5`.
