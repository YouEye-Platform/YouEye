package systemupdate

import (
	"go/ast"
	"go/parser"
	"go/token"
	"go/types"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
)

// Every place that checks an installed or staged service tree, and the mode it
// passes. This is the table in docs/core-release-contract.md. A new call site,
// or a changed mode, has to be decided here: strict only for a tree written by
// the running request (or by a fresh install or a copy), record for every tree
// it did not write. A check that runs in the installed Spine can never be fixed
// by a later release.
//
// What it pins: for every call of a payload check (the callees below) in the
// non-test files of systemupdate, cmd and api, the literal mode argument, per
// function in source order, so two calls of one function cannot swap modes
// unnoticed. Where a call passes a computed mode (the "mode" variable or a call
// such as coreStagePayloadMode(stage)), it pins only that expression; what the
// mode functions return is pinned by TestCoreStageModeFollowsTheStageReceipt
// (coreStagePayloadMode, also behind Schema's "mode"),
// TestCoreHealthIsStrictOnlyForATreeThisRequestWrote (coreHealthPayloadMode,
// behind Health's "mode") and TestCoreInstalledHealthModeTable in cmd
// (coreInstalledHealthMode). The plumbing rows only pass their caller's mode on.
func TestCorePayloadCheckSitesUseTheDecidedMode(t *testing.T) {
	// callee -> index of its mode argument
	callees := map[string]int{"VerifyCoreContainerPayload": 4, "verifyCoreContainerPayload": 4, "coreInstalledPayloadCheck": 4,
		"verifyCoreServiceChild": 4, "verifyCorePayloadDescriptor": 3, "VerifyInstalled": 2, "VerifyCorePayload": 2}
	// Listed per function in source order; the order of functions does not matter.
	want := []string{
		// The installed trees, before anything is written.
		"systemupdate/core_runtime.go execute VerifyCoreContainerPayload CorePayloadRecord",
		"systemupdate/core_checkpoint_capacity.go PreflightCheckpoint VerifyCoreContainerPayload CorePayloadRecord",
		// Staging: the old side is recorded, the side this request writes is strict.
		"systemupdate/core_payload_stage.go extractCorePayload verifyCorePayloadDescriptor CorePayloadStrict",
		"systemupdate/core_service_tree.go coreTreeHoldsExactly verifyCoreServiceChild CorePayloadStrict",
		"systemupdate/core_service_tree.go stageCoreServiceTree verifyCoreServiceChild CorePayloadRecord", // reused member
		"systemupdate/core_service_tree.go stageCoreServiceTree verifyCoreServiceChild CorePayloadRecord", // installed tree before extraction
		"systemupdate/core_service_tree.go stageCoreServiceTree verifyCoreServiceChild CorePayloadStrict", // application directory, already swapped
		"systemupdate/core_service_tree.go stageCoreServiceTree verifyCoreServiceChild CorePayloadRecord", // old tree under the stage name
		"systemupdate/core_service_tree.go stageCoreServiceTree verifyCoreServiceChild CorePayloadRecord", // installed tree before the exchange
		"systemupdate/core_service_tree.go stageCoreServiceTree verifyCoreServiceChild CorePayloadStrict", // extracted stage before the exchange
		"systemupdate/core_service_tree.go stageCoreServiceTree verifyCoreServiceChild CorePayloadStrict", // application directory after the exchange
		"systemupdate/core_service_tree.go stageCoreServiceTree verifyCoreServiceChild CorePayloadRecord", // old tree after the exchange
		// By what this request did.
		"systemupdate/core_service_start.go Start VerifyCoreContainerPayload coreStagePayloadMode(stage)",
		"systemupdate/core_service_schema.go Schema VerifyCoreContainerPayload mode",
		"systemupdate/core_service_schema.go Schema VerifyCoreContainerPayload mode",
		"systemupdate/core_service_health.go Health VerifyCoreContainerPayload mode",
		// Recovery restores a tree this request did not write.
		"systemupdate/core_service_recovery.go recoverService VerifyCoreContainerPayload CorePayloadRecord",
		// Observation, copies, first boot and the health command.
		"systemupdate/core_observation.go VerifyInstalled VerifyCoreContainerPayload mode",
		"cmd/core_observation.go ObserveInstalled VerifyInstalled systemupdate.CorePayloadRecord",
		"cmd/appliance_copy_commit.go init VerifyInstalled systemupdate.CorePayloadStrict",
		"cmd/core_update.go verifyFreshCorePayloads VerifyCoreContainerPayload systemupdate.CorePayloadStrict",
		"cmd/core_installed_health.go addCoreInstalledHealthChecks coreInstalledPayloadCheck coreInstalledHealthMode(journal, member.Role)",
		// Plumbing that passes its caller's mode on.
		"systemupdate/core_payload.go VerifyCorePayload verifyCorePayloadDescriptor mode",
		"systemupdate/core_payload_native.go VerifyCoreContainerPayload verifyCoreContainerPayload mode",
		"systemupdate/core_payload_native.go verifyCoreContainerPayload verifyCorePayloadDescriptor mode",
		"systemupdate/core_service_tree.go verifyCoreServiceChild verifyCorePayloadDescriptor mode",
	}
	type site struct {
		function, call string
		offset         int
	}
	found := []site{}
	for _, dir := range []string{".", "../cmd", "../api"} {
		files, err := filepath.Glob(filepath.Join(dir, "*.go"))
		if err != nil {
			t.Fatal(err)
		}
		for _, file := range files {
			if strings.HasSuffix(file, "_test.go") {
				continue
			}
			pkg := "systemupdate"
			if dir != "." {
				pkg = filepath.Base(dir)
			}
			source, err := os.ReadFile(file)
			if err != nil {
				t.Fatal(err)
			}
			parsed, err := parser.ParseFile(token.NewFileSet(), file, source, 0)
			if err != nil {
				t.Fatal(err)
			}
			for _, decl := range parsed.Decls {
				function := "init"
				if fn, ok := decl.(*ast.FuncDecl); ok {
					function = fn.Name.Name
				}
				ast.Inspect(decl, func(node ast.Node) bool {
					call, ok := node.(*ast.CallExpr)
					if !ok {
						return true
					}
					name := ""
					switch fun := call.Fun.(type) {
					case *ast.Ident:
						name = fun.Name
					case *ast.SelectorExpr:
						name = fun.Sel.Name
					}
					if index, known := callees[name]; known && len(call.Args) > index {
						found = append(found, site{pkg + "/" + filepath.Base(file) + " " + function, name + " " + types.ExprString(call.Args[index]), int(call.Pos())})
					}
					return true
				})
			}
		}
	}
	// Group by file and function; within a function keep source order.
	sort.SliceStable(found, func(i, j int) bool {
		if found[i].function != found[j].function {
			return found[i].function < found[j].function
		}
		return found[i].offset < found[j].offset
	})
	got := []string{}
	for _, f := range found {
		got = append(got, f.function+" "+f.call)
	}
	expected := append([]string(nil), want...)
	sort.SliceStable(expected, func(i, j int) bool { return coreSiteFunction(expected[i]) < coreSiteFunction(expected[j]) })
	if !reflect.DeepEqual(got, expected) {
		t.Fatalf("payload check sites changed; decide the mode of each and update this table and the docs.\ngot:\n  %s\nwant:\n  %s", strings.Join(got, "\n  "), strings.Join(expected, "\n  "))
	}
}

// coreSiteFunction is the "package/file function" part of a site row.
func coreSiteFunction(row string) string {
	fields := strings.SplitN(row, " ", 3)
	return fields[0] + " " + fields[1]
}
