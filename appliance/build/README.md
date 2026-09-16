# Appliance build inputs

The appliance builder is source-owned and runs through the versioned build
manifest. Source identity, the exact release lock, package snapshot and executor
build kit are inputs to independent reproducibility verification.

System and recovery images use Zstandard 1.5.7, level 10, one worker and a 27-bit
long window. The source pins these parameters and rejects a different compressor
version. Policy changes change the signed source identity and require independent
A/B output verification. One worker avoids oversubscribing concurrent jobs.

Level 10 trades moderately larger downloads for shorter compression time.
Decompressed image contents are unchanged. Reverting to the previous level 19
policy requires a source change and a new verified release, not a runtime flag.
