package storage

import "testing"

// ── Adaptive loop-pool sizing ──────────────────────────────────────────────

func TestComputeLoopPoolTarget(t *testing.T) {
	// largeTarget is what ComputePlan would produce (60 GiB reserve policy).
	// For small roots it is 0 (policy declines), so pass 0 there.
	cases := []struct {
		name        string
		rootTotal   int64
		rootAvail   int64
		largeTarget int64
		want        int64
	}{
		{
			// 25 GiB root: reserve 12 GiB, avail 23 GiB → 23-12 = 11 GiB,
			// cap 85% of 25 = 21 GiB → min(11,21) = 11 GiB.
			name:      "25GiB root",
			rootTotal: 25 * GiB, rootAvail: 23 * GiB, largeTarget: 0,
			want: 11 * GiB,
		},
		{
			// 35 GiB root: avail 33, 33-12 = 21 GiB, cap 85% of 35 = 29 →
			// min = 21 GiB.
			name:      "35GiB root",
			rootTotal: 35 * GiB, rootAvail: 33 * GiB, largeTarget: 0,
			want: 21 * GiB,
		},
		{
			// 60 GiB root, mostly free: avail 57, 57-12 = 45 GiB, cap 85% of
			// 60 = 51 → min = 45 GiB.
			name:      "60GiB root",
			rootTotal: 60 * GiB, rootAvail: 57 * GiB, largeTarget: 0,
			want: 45 * GiB,
		},
		{
			// 119 GiB root is still below the 120 GiB large threshold → small
			// policy: avail 115, 115-12 = 103, cap 85% of 119 = 101 →
			// min = 101 GiB.
			name:      "119GiB root (below large threshold)",
			rootTotal: 119 * GiB, rootAvail: 115 * GiB, largeTarget: 0,
			want: 101 * GiB,
		},
		{
			// 120 GiB root hits the large threshold → defer to largeTarget.
			name:      "120GiB root (large threshold, uses largeTarget)",
			rootTotal: 120 * GiB, rootAvail: 115 * GiB, largeTarget: 60 * GiB,
			want: 60 * GiB,
		},
		{
			// Large host but ComputePlan declined (largeTarget < min) → 0.
			name:      "large host, policy declined",
			rootTotal: 200 * GiB, rootAvail: 5 * GiB, largeTarget: 0,
			want: 0,
		},
		{
			// Tiny disk: 15 GiB root, avail 14 → 14-12 = 2 GiB < 8 GiB min → 0.
			name:      "tiny disk fails",
			rootTotal: 15 * GiB, rootAvail: 14 * GiB, largeTarget: 0,
			want: 0,
		},
		{
			name:      "zero inputs",
			rootTotal: 0, rootAvail: 0, largeTarget: 0,
			want: 0,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := computeLoopPoolTarget(tc.rootTotal, tc.rootAvail, tc.largeTarget)
			if got != tc.want {
				t.Fatalf("computeLoopPoolTarget(%s,%s,%s) = %s, want %s",
					FormatBytes(tc.rootTotal), FormatBytes(tc.rootAvail), FormatBytes(tc.largeTarget),
					FormatBytes(got), FormatBytes(tc.want))
			}
		})
	}
}

// ── Blank-disk detection ───────────────────────────────────────────────────

func baseInput(devs ...BlockDevice) diskCandidateInput {
	return diskCandidateInput{
		Devices:   devs,
		RootDisks: map[string]bool{"/dev/sda": true, "sda": true},
		FstabDevs: map[string]bool{},
		SwapDevs:  map[string]bool{},
	}
}

func TestIsBlankCandidate(t *testing.T) {
	rootDisk := BlockDevice{Name: "sda", Path: "/dev/sda", Type: "disk", SizeBytes: 25 * GiB, PartTable: "gpt",
		Children: []BlockDevice{{Name: "sda1", Path: "/dev/sda1", Type: "part", FSType: "ext4", MountPoint: "/"}}}

	blank := BlockDevice{Name: "sdb", Path: "/dev/sdb", Type: "disk", SizeBytes: 15 * GiB}

	cases := []struct {
		name string
		dev  BlockDevice
		in   diskCandidateInput
		want bool
	}{
		{"blank secondary disk", blank, baseInput(rootDisk, blank), true},
		{"root disk rejected", rootDisk, baseInput(rootDisk, blank), false},
		{
			"disk with partition table rejected",
			BlockDevice{Name: "sdb", Path: "/dev/sdb", Type: "disk", SizeBytes: 15 * GiB, PartTable: "gpt"},
			baseInput(rootDisk), false,
		},
		{
			"disk with fs signature rejected",
			BlockDevice{Name: "sdb", Path: "/dev/sdb", Type: "disk", SizeBytes: 15 * GiB, FSType: "ext4"},
			baseInput(rootDisk), false,
		},
		{
			"disk with zfs residue rejected",
			BlockDevice{Name: "sdb", Path: "/dev/sdb", Type: "disk", SizeBytes: 15 * GiB,
				Children: []BlockDevice{{Name: "sdb1", Path: "/dev/sdb1", Type: "part", FSType: "zfs_member"}}},
			baseInput(rootDisk), false,
		},
		{
			"too small rejected",
			BlockDevice{Name: "sdb", Path: "/dev/sdb", Type: "disk", SizeBytes: 4 * GiB},
			baseInput(rootDisk), false,
		},
		{
			"loop device rejected",
			BlockDevice{Name: "loop0", Path: "/dev/loop0", Type: "loop", SizeBytes: 15 * GiB},
			baseInput(rootDisk), false,
		},
		{
			"zd volume rejected",
			BlockDevice{Name: "zd0", Path: "/dev/zd0", Type: "disk", SizeBytes: 15 * GiB},
			baseInput(rootDisk), false,
		},
		{
			"fstab-referenced disk rejected",
			blank,
			diskCandidateInput{RootDisks: map[string]bool{"/dev/sda": true}, FstabDevs: map[string]bool{"/dev/sdb": true}},
			false,
		},
		{
			"swap disk rejected",
			blank,
			diskCandidateInput{RootDisks: map[string]bool{"/dev/sda": true}, SwapDevs: map[string]bool{"/dev/sdb": true}},
			false,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, reason := isBlankCandidate(tc.dev, tc.in)
			if got != tc.want {
				t.Fatalf("isBlankCandidate = %v (want %v), reason: %s", got, tc.want, reason)
			}
		})
	}
}

func TestSelectBlankDiskSmallest(t *testing.T) {
	root := BlockDevice{Name: "sda", Path: "/dev/sda", Type: "disk", SizeBytes: 25 * GiB, PartTable: "gpt"}
	big := BlockDevice{Name: "sdb", Path: "/dev/sdb", Type: "disk", SizeBytes: 40 * GiB}
	small := BlockDevice{Name: "sdc", Path: "/dev/sdc", Type: "disk", SizeBytes: 15 * GiB}

	in := diskCandidateInput{
		Devices:   []BlockDevice{root, big, small},
		RootDisks: map[string]bool{"/dev/sda": true},
	}
	got, _, _ := selectBlankDisk(in)
	if got == nil {
		t.Fatal("expected a candidate, got nil")
	}
	if got.Path != "/dev/sdc" {
		t.Fatalf("expected smallest disk /dev/sdc, got %s", got.Path)
	}
}

func TestSelectBlankDiskStaleResidueHint(t *testing.T) {
	root := BlockDevice{Name: "sda", Path: "/dev/sda", Type: "disk", SizeBytes: 25 * GiB, PartTable: "gpt"}
	stale := BlockDevice{Name: "sdb", Path: "/dev/sdb", Type: "disk", SizeBytes: 15 * GiB,
		Children: []BlockDevice{{Name: "sdb1", Path: "/dev/sdb1", Type: "part", FSType: "zfs_member"}}}

	in := diskCandidateInput{
		Devices:   []BlockDevice{root, stale},
		RootDisks: map[string]bool{"/dev/sda": true},
	}
	got, _, hint := selectBlankDisk(in)
	if got != nil {
		t.Fatalf("stale-residue disk must NOT be auto-claimed, got %s", got.Path)
	}
	if hint == "" {
		t.Fatal("expected an actionable stale-residue hint")
	}
}

// ── Decision tree ──────────────────────────────────────────────────────────

func TestResolveDecisionAdoptMarkedPool(t *testing.T) {
	dec := ResolveDecision(DecisionInputs{
		Policy:             appliancePolicy(),
		MarkedPoolImported: true,
	})
	if dec.Kind != DecisionAdoptMarkedPool || !dec.DataOnZFS {
		t.Fatalf("got %+v", dec)
	}
}

func TestDatasetMountpointNeedsSet(t *testing.T) {
	if datasetMountpointNeedsSet("/var/lib/incus", "/var/lib/incus") {
		t.Fatal("matching mountpoint should not be reset")
	}
	if !datasetMountpointNeedsSet("/legacy/incus", "/var/lib/incus") {
		t.Fatal("different mountpoint should be reset")
	}
	if datasetMountpointNeedsSet(" /var/lib/youeye ", "/var/lib/youeye") {
		t.Fatal("surrounding whitespace should not force a reset")
	}
}

func TestResolveDecisionLegacyPool(t *testing.T) {
	dec := ResolveDecision(DecisionInputs{
		Policy:             appliancePolicy(),
		LegacyPoolImported: true,
	})
	if dec.Kind != DecisionReuseLegacyPool || dec.DataOnZFS {
		t.Fatalf("got %+v", dec)
	}
}

func TestResolveDecisionCreateOnBlankDisk(t *testing.T) {
	root := BlockDevice{Name: "sda", Path: "/dev/sda", Type: "disk", SizeBytes: 25 * GiB, PartTable: "gpt"}
	blank := BlockDevice{Name: "sdb", Path: "/dev/sdb", Type: "disk", SizeBytes: 15 * GiB}
	dec := ResolveDecision(DecisionInputs{
		Policy:         appliancePolicy(),
		RootTotalBytes: 25 * GiB, RootAvailBytes: 20 * GiB,
		ZFSAvailable: false, ZFSInstallable: true,
		Devices:   []BlockDevice{root, blank},
		RootDisks: map[string]bool{"/dev/sda": true},
	})
	if dec.Kind != DecisionCreateOnDisk || dec.Disk != "/dev/sdb" || !dec.DataOnZFS {
		t.Fatalf("got %+v", dec)
	}
}

func TestResolveDecisionLoopPoolSingleDisk(t *testing.T) {
	root := BlockDevice{Name: "sda", Path: "/dev/sda", Type: "disk", SizeBytes: 35 * GiB, PartTable: "gpt"}
	dec := ResolveDecision(DecisionInputs{
		Policy:         appliancePolicy(),
		RootTotalBytes: 35 * GiB, RootAvailBytes: 33 * GiB,
		ZFSAvailable: false, ZFSInstallable: true,
		Devices:   []BlockDevice{root},
		RootDisks: map[string]bool{"/dev/sda": true},
	})
	if dec.Kind != DecisionLoopPool {
		t.Fatalf("got kind %s (%+v)", dec.Kind, dec)
	}
	if dec.LoopSizeBytes != 21*GiB {
		t.Fatalf("loop size = %s, want 21 GiB", FormatBytes(dec.LoopSizeBytes))
	}
	if dec.DataOnZFS {
		t.Fatal("loop pool must keep data on root fs")
	}
}

func TestResolveDecisionTinyDiskFails(t *testing.T) {
	root := BlockDevice{Name: "sda", Path: "/dev/sda", Type: "disk", SizeBytes: 15 * GiB, PartTable: "gpt"}
	dec := ResolveDecision(DecisionInputs{
		Policy:         appliancePolicy(),
		RootTotalBytes: 15 * GiB, RootAvailBytes: 14 * GiB,
		ZFSAvailable: true, ZFSInstallable: true,
		Devices:   []BlockDevice{root},
		RootDisks: map[string]bool{"/dev/sda": true},
	})
	if dec.Kind != DecisionFail {
		t.Fatalf("expected DecisionFail on a tiny disk, got %s (%+v)", dec.Kind, dec)
	}
}

func TestResolveDecisionContainerUsesDir(t *testing.T) {
	dec := ResolveDecision(DecisionInputs{
		Policy:      appliancePolicy(),
		InContainer: true,
	})
	if dec.Kind != DecisionDir {
		t.Fatalf("container must use dir driver, got %s", dec.Kind)
	}
}

func TestResolveDecisionNoZFSFallsBackToDir(t *testing.T) {
	root := BlockDevice{Name: "sda", Path: "/dev/sda", Type: "disk", SizeBytes: 35 * GiB, PartTable: "gpt"}
	dec := ResolveDecision(DecisionInputs{
		Policy:         appliancePolicy(),
		RootTotalBytes: 35 * GiB, RootAvailBytes: 33 * GiB,
		ZFSAvailable: false, ZFSInstallable: false, // e.g. ZFS install failed
		Devices:   []BlockDevice{root},
		RootDisks: map[string]bool{"/dev/sda": true},
	})
	if dec.Kind != DecisionDir {
		t.Fatalf("no-ZFS single disk must fall back to dir, got %s", dec.Kind)
	}
}

func TestResolveDecisionStaleResidueHintThenLoop(t *testing.T) {
	root := BlockDevice{Name: "sda", Path: "/dev/sda", Type: "disk", SizeBytes: 35 * GiB, PartTable: "gpt"}
	stale := BlockDevice{Name: "sdb", Path: "/dev/sdb", Type: "disk", SizeBytes: 15 * GiB,
		Children: []BlockDevice{{Name: "sdb1", Path: "/dev/sdb1", Type: "part", FSType: "zfs_member"}}}
	dec := ResolveDecision(DecisionInputs{
		Policy:         appliancePolicy(),
		RootTotalBytes: 35 * GiB, RootAvailBytes: 33 * GiB,
		ZFSAvailable: true, ZFSInstallable: true,
		Devices:   []BlockDevice{root, stale},
		RootDisks: map[string]bool{"/dev/sda": true},
	})
	if dec.Kind != DecisionLoopPool {
		t.Fatalf("stale-residue disk should not be claimed; expected loop pool, got %s", dec.Kind)
	}
	if dec.Hint == "" {
		t.Fatal("expected the stale-residue hint to be carried through")
	}
}

// ── Parsers ────────────────────────────────────────────────────────────────

func TestParseLsblk(t *testing.T) {
	out := `{
	   "blockdevices": [
	      {"name":"sda","path":"/dev/sda","type":"disk","size":26843545600,"fstype":null,"mountpoint":null,"pttype":"gpt",
	         "children":[{"name":"sda1","path":"/dev/sda1","type":"part","size":26000000000,"fstype":"ext4","mountpoint":"/","pttype":null}]},
	      {"name":"sdb","path":"/dev/sdb","type":"disk","size":16106127360,"fstype":null,"mountpoint":null,"pttype":null},
	      {"name":"sr0","path":"/dev/sr0","type":"rom","size":1073741824,"fstype":null,"mountpoint":null,"pttype":null}
	   ]
	}`
	devs := parseLsblk(out)
	if len(devs) != 3 {
		t.Fatalf("expected 3 devices, got %d", len(devs))
	}
	if devs[0].Name != "sda" || devs[0].PartTable != "gpt" || devs[0].SizeBytes != 26843545600 {
		t.Fatalf("sda parsed wrong: %+v", devs[0])
	}
	if len(devs[0].Children) != 1 || devs[0].Children[0].FSType != "ext4" || devs[0].Children[0].MountPoint != "/" {
		t.Fatalf("sda1 parsed wrong: %+v", devs[0].Children)
	}
	if devs[1].SizeBytes != 16106127360 || devs[1].PartTable != "" {
		t.Fatalf("sdb parsed wrong: %+v", devs[1])
	}
}

func TestRootDiskPaths(t *testing.T) {
	devs := []BlockDevice{
		{Name: "sda", Path: "/dev/sda", Type: "disk", Children: []BlockDevice{{Name: "sda1", Path: "/dev/sda1", Type: "part"}}},
		{Name: "sdb", Path: "/dev/sdb", Type: "disk"},
	}
	got := rootDiskPaths(devs, "/dev/sda1", "/dev/sda1")
	if !got["/dev/sda"] {
		t.Fatalf("expected /dev/sda to be flagged as root disk, got %v", got)
	}
	if got["/dev/sdb"] {
		t.Fatalf("/dev/sdb should NOT be a root disk, got %v", got)
	}
}

func TestParseFstabDevices(t *testing.T) {
	content := `# comment
/dev/sdb1 /data ext4 defaults 0 2
UUID=abc / ext4 defaults 0 1
/var/swapfile swap swap defaults 0 0
`
	got := parseFstabDevices(content)
	if !got["/dev/sdb1"] {
		t.Fatalf("expected /dev/sdb1 in fstab devices, got %v", got)
	}
	// UUID and file-path swap entries are not /dev paths, so absent.
	if got["/var/swapfile"] {
		t.Fatal("swapfile path is not a /dev device and must not be recorded")
	}
}

func TestParseSwapDevices(t *testing.T) {
	out := "/dev/sdb2\n/var/swapfile\n"
	got := parseSwapDevices(out)
	if !got["/dev/sdb2"] {
		t.Fatalf("expected /dev/sdb2 as swap device, got %v", got)
	}
	if got["/var/swapfile"] {
		t.Fatal("file-backed swap must not be recorded as a device")
	}
}

func TestParsePoolMembers(t *testing.T) {
	out := `  pool: default
 state: ONLINE
config:

	NAME        STATE     READ WRITE CKSUM
	default     ONLINE       0     0     0
	  /dev/sdb  ONLINE       0     0     0

errors: No known data errors
`
	members := parsePoolMembers(out)
	if len(members) != 1 || members[0] != "/dev/sdb" {
		t.Fatalf("expected [/dev/sdb], got %v", members)
	}
}

func TestParsePoolMembersPartition(t *testing.T) {
	out := `config:

	NAME                       STATE
	default                    ONLINE
	  /dev/disk/by-id/wwn-0x5-part1  ONLINE
`
	members := parsePoolMembers(out)
	if len(members) != 1 || members[0] != "/dev/disk/by-id/wwn-0x5-part1" {
		t.Fatalf("got %v", members)
	}
}

func TestWholeDiskOf(t *testing.T) {
	cases := map[string]string{
		"/dev/sdb1":      "/dev/sdb",
		"/dev/sdb":       "/dev/sdb",
		"/dev/nvme0n1p1": "/dev/nvme0n1",
		"/dev/nvme0n1":   "/dev/nvme0n1",
		"/dev/vda2":      "/dev/vda",
		"/dev/mmcblk0p1": "/dev/mmcblk0",
	}
	for in, want := range cases {
		if got := WholeDiskOf(in); got != want {
			t.Fatalf("WholeDiskOf(%s) = %s, want %s", in, got, want)
		}
	}
}
