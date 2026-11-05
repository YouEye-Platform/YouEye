package incus

import (
	"errors"
	"go/ast"
	"go/parser"
	"go/token"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"

	"github.com/youeye-platform/YouEye/spine/internal/appliance"
)

type fakePrerequisiteProbe struct {
	missing map[string]bool
	output  map[string]string
}

func (f fakePrerequisiteProbe) LookPath(name string) (string, error) {
	if f.missing[name] {
		return "", errors.New("missing")
	}
	return "/bin/" + name, nil
}
func (f fakePrerequisiteProbe) Stat(path string) error {
	if f.missing[path] {
		return errors.New("missing")
	}
	return nil
}
func (f fakePrerequisiteProbe) Run(name string, args ...string) (string, error) {
	if f.missing["run:"+name] {
		return "", errors.New("failed")
	}
	return f.output[name], nil
}

func TestVerifyBakedPrerequisitesAggregatesFailures(t *testing.T) {
	m := appliance.Manifest{KernelCompatibility: ">=6.12", ZFSCompatibility: ">=2.3", ZFSFeatureProfile: "openzfs-2.2", IncusCompatibility: ">=7.0"}
	f := fakePrerequisiteProbe{missing: map[string]bool{"pamtester": true, "/dev/zfs": true, "/usr/share/zfs/compatibility.d/openzfs-2.2": true}, output: map[string]string{"uname": "6.11.0", "zfs": "zfs-2.3.1", "incus": "7.2"}}
	err := verifyBakedPrerequisites(m, f)
	if err == nil {
		t.Fatal("expected aggregate failure")
	}
	for _, want := range []string{"pamtester", "/dev/zfs", "openzfs-2.2", "kernel"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("missing %q in %v", want, err)
		}
	}
}

func TestReconcileApplianceHasNoMutableHostMutationCommands(t *testing.T) {
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate appliance test source")
	}
	path := filepath.Join(filepath.Dir(currentFile), "appliance.go")
	fset := token.NewFileSet()
	parsed, err := parser.ParseFile(fset, path, nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	var target *ast.FuncDecl
	for _, decl := range parsed.Decls {
		fn, ok := decl.(*ast.FuncDecl)
		if ok && fn.Name.Name == "ReconcileAppliance" {
			target = fn
			break
		}
	}
	if target == nil {
		t.Fatal("ReconcileAppliance not found")
	}
	ast.Inspect(target.Body, func(node ast.Node) bool {
		call, ok := node.(*ast.CallExpr)
		if !ok {
			return true
		}
		selector, ok := call.Fun.(*ast.SelectorExpr)
		if !ok {
			return true
		}
		owner, _ := selector.X.(*ast.Ident)
		name := selector.Sel.Name
		if owner != nil {
			name = owner.Name + "." + name
		}
		if name == "os.WriteFile" || name == "os.Remove" || name == "os.RemoveAll" {
			t.Errorf("appliance reconciliation contains host filesystem mutation %s", name)
		}
		if name != "exec.Command" || len(call.Args) == 0 {
			return true
		}
		var argv []string
		for _, arg := range call.Args {
			literal, ok := arg.(*ast.BasicLit)
			if !ok || literal.Kind != token.STRING {
				continue
			}
			value, err := strconv.Unquote(literal.Value)
			if err == nil {
				argv = append(argv, value)
			}
		}
		joined := strings.Join(argv, " ")
		for _, forbidden := range []string{"apt", "apt-get", "dpkg", "add-apt-repository", "wipefs", "zpool upgrade", "zpool destroy", "zpool labelclear", "systemctl enable", "systemctl disable", "systemctl daemon-reload"} {
			if strings.Contains(joined, forbidden) {
				t.Errorf("appliance reconciliation contains forbidden command %q in %q", forbidden, joined)
			}
		}
		return true
	})
}

func TestVersionSatisfies(t *testing.T) {
	for _, tc := range []struct {
		actual, required string
		ok               bool
	}{{"6.12.3-amd64", ">=6.12", true}, {"zfs-2.2.9", ">=2.3", false}, {"7.2", "7.2", true}} {
		err := versionSatisfies(tc.actual, tc.required)
		if (err == nil) != tc.ok {
			t.Errorf("versionSatisfies(%q,%q)=%v", tc.actual, tc.required, err)
		}
	}
}
