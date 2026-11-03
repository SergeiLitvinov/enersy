package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"strings"
	"testing"
)

func currentSDKRoot(t *testing.T) string {
	t.Helper()
	root, err := goOutput(context.Background(), "env", "GOROOT")
	if err != nil || strings.TrimSpace(string(root)) == "" {
		t.Fatal("cannot locate current Go SDK", err)
	}
	return strings.TrimSpace(string(root))
}

func TestAuxiliarySourcePreservesCompleteTextAndBoundaries(t *testing.T) {
	root := t.TempDir()
	texts := map[string]string{
		"a.s": "// Copyright original authors\r\nTEXT ·fixture(SB),0,$0\r\n// Additional terms after code\r\n",
		"b.h": "/* Header author */\n#define FIXTURE 1\n/* Permission and disclaimer */\n",
	}
	for name, text := range texts {
		if err := os.WriteFile(filepath.Join(root, name), []byte(text), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	notices := map[string]string{}
	r, err := collectAuxiliarySourceAttributions(root, []string{"b.h", "a.s", "a.s"}, notices)
	if err != nil || len(r.Files) != 2 || r.Files[0].Name != "a.s" {
		t.Fatalf("%+v %v", r, err)
	}
	for _, file := range r.Files {
		if notices[file.SHA256] != texts[file.Name] || file.SHA256 != digest([]byte(texts[file.Name])) {
			t.Fatal("source bytes changed")
		}
	}
}

func TestAuxiliarySourceRejectsInvalidEvidence(t *testing.T) {
	for _, tc := range []struct {
		name string
		data []byte
	}{
		{"source.s", nil}, {"source.s", []byte{0xff}}, {"source.s", []byte("TEXT\x00binary")},
		{"source.s", []byte(strings.Repeat("x", maxNoticeBytes+1))},
		{"source.go", []byte("package fixture")}, {"source.syso", []byte("object")},
		{"../outside.s", nil}, {"sub/../source.s", nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			if !strings.Contains(tc.name, "/") {
				if err := os.WriteFile(filepath.Join(root, tc.name), tc.data, 0o600); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := collectAuxiliarySourceAttributions(root, []string{tc.name}, map[string]string{}); err == nil {
				t.Fatal("invalid source accepted")
			}
		})
	}
	t.Run("escaping symlink", func(t *testing.T) {
		root := t.TempDir()
		outside := filepath.Join(t.TempDir(), "external.s")
		if err := os.WriteFile(outside, []byte("// Other package notice"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(outside, filepath.Join(root, "source.s")); err != nil {
			t.Fatal(err)
		}
		if _, err := collectAuxiliarySourceAttributions(root, []string{"source.s"}, map[string]string{}); err == nil {
			t.Fatal("escape accepted")
		}
	})
}

func TestAuxiliaryPackageSelectionKeepsSDKAndModuleSeparate(t *testing.T) {
	root := t.TempDir()
	packages := []goPackage{
		{Standard: true, Dir: filepath.Join(root, "src", "runtime"), SFiles: []string{"asm_amd64.s"}, HFiles: []string{"textflag.h"}, GoFiles: []string{"runtime.go"}},
		{Module: &goModule{Path: "example.org/dependency"}, Dir: filepath.Join(root, "dependency"), SFiles: []string{"native.s"}},
	}
	for _, tc := range []struct {
		module string
		count  int
	}{{"go", 2}, {"example.org/dependency", 1}} {
		names, err := packageAuxiliarySourceNames(packages, root, tc.module)
		if err != nil || len(names) != tc.count {
			t.Fatal(names, err)
		}
		for _, name := range names {
			if filepath.Ext(name) == ".go" {
				t.Fatal("Go source mixed with assembly")
			}
		}
	}
	for _, pkg := range []goPackage{
		{Standard: true, Dir: root, SFiles: []string{"../external.s"}},
		{Standard: true, Dir: t.TempDir(), HFiles: []string{"external.h"}},
		{Standard: true, Dir: root, SFiles: []string{"object.syso"}},
		{Standard: true, Dir: root, CgoFiles: []string{"cgo.go"}},
	} {
		if _, err := packageAuxiliarySourceNames([]goPackage{pkg}, root, "go"); err == nil {
			t.Fatal("invalid selection accepted")
		}
	}
}

func TestActualSDKAssemblyAndHeaderBytes(t *testing.T) {
	root := currentSDKRoot(t)
	names := []string{filepath.Join("src", "runtime", "asm_"+runtime.GOARCH+".s"), filepath.Join("src", "runtime", "textflag.h")}
	notices := map[string]string{}
	r, err := collectAuxiliarySourceAttributions(root, names, notices)
	if err != nil || len(r.Files) != 2 {
		t.Fatal(r, err)
	}
	for _, file := range r.Files {
		raw, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(file.Name)))
		if err != nil || string(raw) != notices[file.SHA256] || digest(raw) != file.SHA256 {
			t.Fatal("SDK source changed", err)
		}
	}
}

func TestGoSourceProloguesPreserveAllGroupsAndBytes(t *testing.T) {
	root := t.TempDir()
	header := "\ufeff//go:build linux\r\n\r\n// Copyright © Автор\r\n// Permission is in LICENSE.\r\n\r\n/* Additional authors and terms. */\r\n\r\n"
	for _, name := range []string{"a.go", "b.go"} {
		if err := os.WriteFile(filepath.Join(root, name), []byte(header+"package fixture\r\n// Copyright after package is retained too.\r\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(root, "plain.go"), []byte("package fixture\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	notices := map[string]string{}
	r, err := collectGoSourceAttributions(root, []string{"b.go", "plain.go", "a.go", "a.go"}, notices)
	if err != nil || len(r.Files) != 3 || len(notices) != 2 {
		t.Fatalf("files=%+v texts=%d err=%v", r.Files, len(notices), err)
	}
	for i, name := range []string{"a.go", "b.go", "plain.go"} {
		file := r.Files[i]
		if file.Name != name {
			t.Fatal("unstable source order", file)
		}
		data, err := os.ReadFile(filepath.Join(root, name))
		if err != nil || file.SourceSHA256 != digest(data) {
			t.Fatal("source fingerprint does not match", err)
		}
		if name == "plain.go" {
			if file.HeaderBytes != 0 || file.HeaderSHA256 != "" {
				t.Fatal("invented source header", file)
			}
		} else if file.HeaderBytes != len(header) || notices[file.HeaderSHA256] != header || file.HeaderSHA256 != digest([]byte(header)) {
			t.Fatal("prologue lost bytes or separate attribution groups", file)
		}
	}
	encoded, err := json.Marshal(notices)
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]string
	if err = json.Unmarshal(encoded, &decoded); err != nil || decoded[digest([]byte(header))] != header {
		t.Fatal("JSON changed attribution bytes", err)
	}
}

func TestGoSourceProloguesRejectInvalidEvidence(t *testing.T) {
	for _, kind := range []string{"invalid-utf8", "invalid-package", "invalid-body", "oversized", "outside-link", "directory", "missing", "parent-path", "absolute-path", "wrong-extension"} {
		t.Run(kind, func(t *testing.T) {
			root := t.TempDir()
			name := "source.go"
			path := filepath.Join(root, name)
			data := []byte("// Attribution\npackage fixture\n")
			switch kind {
			case "invalid-utf8":
				data = []byte{0xff}
			case "invalid-package":
				data = []byte("// Attribution\nnot_a_package\n")
			case "invalid-body":
				data = []byte("package fixture\n/* Unterminated attribution")
			case "oversized":
				data = []byte(strings.Repeat("a", maxGoSourceBytes+1))
			case "outside-link":
				outside := filepath.Join(t.TempDir(), name)
				if err := os.WriteFile(outside, data, 0o600); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(outside, path); err != nil {
					t.Fatal(err)
				}
				data = nil
			case "directory":
				if err := os.Mkdir(path, 0o700); err != nil {
					t.Fatal(err)
				}
				data = nil
			case "missing":
				data = nil
			case "parent-path":
				name = filepath.Join("..", "source.go")
				data = nil
			case "absolute-path":
				name = path
			case "wrong-extension":
				name = "source.txt"
				path = filepath.Join(root, name)
			}
			if data != nil {
				if err := os.WriteFile(path, data, 0o600); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := collectGoSourceAttributions(root, []string{name}, map[string]string{}); err == nil {
				t.Fatal("unsafe source evidence accepted")
			}
		})
	}
}

func TestSourceCommentsRetainPostPackageCRLFAndIgnoreStrings(t *testing.T) {
	root := t.TempDir()
	header := "// Author in the prologue\r\n\r\n"
	block := "/* Copyright © additional authors\r\n * Permission and disclaimer\r\n */"
	inner := "// Условия внутри функции\r\n\t// Additional terms\r"
	last := "// Final attribution without newline"
	source := header + "package fixture\r\n" + block + "\r\nvar fake = \"/* Copyright not a comment */\"\r\nvar raw = `// Copyright not a comment\r\n/* not a comment either */`\r\nfunc f() {\r\n\t" + inner + "\n\t_ = fake\r\n}\r\n" + last
	if err := os.WriteFile(filepath.Join(root, "source.go"), []byte(source), 0o600); err != nil {
		t.Fatal(err)
	}
	notices := map[string]string{}
	r, err := collectGoSourceAttributions(root, []string{"source.go"}, notices)
	if err != nil || len(r.Files) != 1 || len(r.Files[0].Comments) != 3 || len(notices) != 4 {
		t.Fatalf("inventory=%+v texts=%d err=%v", r, len(notices), err)
	}
	for i, expected := range []string{block, inner, last} {
		comment := r.Files[0].Comments[i]
		if source[comment.StartByte:comment.EndByte] != expected || notices[comment.SHA256] != expected || digest([]byte(expected)) != comment.SHA256 {
			t.Fatal("source comment byte range changed", comment)
		}
	}
}

func TestSourcePackagePathsKeepModuleBoundaries(t *testing.T) {
	root := t.TempDir()
	packages := []goPackage{
		{Standard: true, Dir: filepath.Join(root, "src", "fixture"), GoFiles: []string{"sdk.go"}},
		{Module: &goModule{Path: "example.org/dependency"}, Dir: filepath.Join(root, "fixture"), GoFiles: []string{"module.go"}},
	}
	for _, tc := range []struct{ module, expected string }{{"go", filepath.Join("src", "fixture", "sdk.go")}, {"example.org/dependency", filepath.Join("fixture", "module.go")}} {
		names, err := packageSourceNames(packages, root, tc.module)
		if err != nil || len(names) != 1 || names[0] != tc.expected {
			t.Fatalf("module=%s names=%v err=%v", tc.module, names, err)
		}
	}
	for _, pkg := range []goPackage{
		{Standard: true, Dir: t.TempDir(), GoFiles: []string{"external.go"}},
		{Standard: true, Dir: root, GoFiles: []string{"../external.go"}},
		{Standard: true, Dir: root, CgoFiles: []string{"cgo.go"}},
	} {
		if _, err := packageSourceNames([]goPackage{pkg}, root, "go"); err == nil {
			t.Fatal("source scope mismatch accepted")
		}
	}
}

func TestSourcePackagesRefuseOtherBuildConfigurations(t *testing.T) {
	for _, setting := range []debug.BuildSetting{{Key: "GOOS", Value: "another-os"}, {Key: "GOARCH", Value: "another-arch"}, {Key: "CGO_ENABLED", Value: "1"}, {Key: "GOAMD64", Value: "v3"}, {Key: "GOARM64", Value: "v9.0"}, {Key: "GOEXPERIMENT", Value: "another-experiment"}, {Key: "GOFIPS140", Value: "latest"}, {Key: "-compiler", Value: "gccgo"}, {Key: "-tags", Value: "custom"}, {Key: "-tags", Value: "false"}, {Key: "-race", Value: "true"}, {Key: "-asan", Value: "true"}, {Key: "-msan", Value: "true"}} {
		t.Run(setting.Key, func(t *testing.T) {
			if _, err := sourcePackages(context.Background(), &debug.BuildInfo{Settings: []debug.BuildSetting{setting}}, map[string]string{}); err == nil {
				t.Fatal("binary and source selection mismatch accepted")
			}
		})
	}
	for _, env := range []map[string]string{{"CGO_ENABLED": "1", "GOARCH": "amd64"}, {"CGO_ENABLED": "0", "GOARCH": "386"}} {
		if _, err := sourcePackages(context.Background(), &debug.BuildInfo{}, env); err == nil {
			t.Fatal("unsupported source variant accepted")
		}
	}
}

func TestSourcePackageModulesMatchTheBinary(t *testing.T) {
	info := &debug.BuildInfo{Main: debug.Module{Path: "example.org/main"}, Deps: []*debug.Module{{Path: "example.org/dep", Version: "v1.0.0"}}}
	for _, pkg := range []goPackage{{Standard: true}, {Module: &goModule{Path: info.Main.Path}}, {Module: &goModule{Path: "example.org/dep", Version: "v1.0.0"}}} {
		if err := validateSourcePackageModules([]goPackage{pkg}, info); err != nil {
			t.Fatal(err)
		}
	}
	for _, pkg := range []goPackage{{}, {Module: &goModule{Path: "example.org/unknown", Version: "v1.0.0"}}, {Module: &goModule{Path: "example.org/dep", Version: "v2.0.0"}}, {Module: &goModule{Path: "example.org/dep", Version: "v1.0.0", Replace: &goModule{Path: "replacement"}}}} {
		if err := validateSourcePackageModules([]goPackage{pkg}, info); err == nil {
			t.Fatal("source graph for a different binary accepted")
		}
	}
}

func TestSourcePackagesRejectUnrecordedExperiments(t *testing.T) {
	info := &debug.BuildInfo{Settings: []debug.BuildSetting{{Key: "GOOS", Value: "linux"}, {Key: "GOARCH", Value: "amd64"}, {Key: "CGO_ENABLED", Value: "0"}}}
	for _, key := range []string{"GOEXPERIMENT", "GOFIPS140"} {
		env := map[string]string{"GOOS": "linux", "GOARCH": "amd64", "CGO_ENABLED": "0", key: "custom"}
		if _, err := sourcePackages(context.Background(), info, env); err == nil {
			t.Fatal("environment selects source features absent from the binary")
		}
	}
}

func TestGoMetadataIgnoresAmbientBuildFlags(t *testing.T) {
	t.Setenv("GOFLAGS", "-tags=unreviewed -race")
	output, err := goOutput(context.Background(), "env", "GOFLAGS")
	if err != nil || strings.TrimSpace(string(output)) != "-mod=readonly" {
		t.Fatal("ambient flags influence metadata source selection", err)
	}
}

func TestActualSDKRetainsInlineFiatAndSunTerms(t *testing.T) {
	conditions := map[string][]string{
		"src/crypto/internal/fips140/edwards25519/scalar.go": {"The fiat-crypto Authors", "Redistribution and use in source and binary forms", "SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE."},
		"src/math/acosh.go": {"Copyright (C) 1993 by Sun Microsystems", "Permission to use, copy, modify, and distribute", "is preserved."},
	}
	names := []string{}
	for name := range conditions {
		names = append(names, name)
	}
	notices := map[string]string{}
	r, err := collectGoSourceAttributions(currentSDKRoot(t), names, notices)
	if err != nil || len(r.Files) != 2 {
		t.Fatal("cannot inventory actual SDK inline notices", err)
	}
	for _, file := range r.Files {
		found := false
		for _, comment := range file.Comments {
			text := notices[comment.SHA256]
			complete := true
			for _, condition := range conditions[file.Name] {
				complete = complete && strings.Contains(text, condition)
			}
			found = found || complete
		}
		if !found {
			t.Fatal("complete inline copyright, conditions and disclaimer missing", file.Name)
		}
	}
}

func TestNoticesPreserveExactText(t *testing.T) {
	root := t.TempDir()
	text := "\ufeffCopyright © Авторы\r\nPermission and disclaimer\r\n"
	for _, name := range []string{"LICENSE", "COPYING.txt"} {
		if err := os.WriteFile(filepath.Join(root, name), []byte(text), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	for _, name := range []string{"README.md", "notice.go", "notice_example_test.go", "license.json"} {
		if err := os.WriteFile(filepath.Join(root, name), []byte("Source or link, not a license text"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	notices := map[string]string{}
	files, err := collectNotices(root, notices)
	if err != nil || len(files) != 2 || len(notices) != 1 {
		t.Fatalf("files=%v notices=%v err=%v", files, notices, err)
	}
	data, err := json.Marshal(notices)
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]string
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded[digest([]byte(text))] != text || files[0].Name != "COPYING.txt" || files[1].Name != "LICENSE" {
		t.Fatal("attribution bytes or deterministic ordering changed")
	}
}

func TestNoticeSourceFailures(t *testing.T) {
	for _, tc := range []struct {
		name string
		data []byte
	}{
		{"empty", nil},
		{"invalid-utf8", []byte{0xff, 0xfe}},
		{"oversized", []byte(strings.Repeat("a", maxNoticeBytes+1))},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			if err := os.WriteFile(filepath.Join(root, "LICENSE"), tc.data, 0o600); err != nil {
				t.Fatal(err)
			}
			if _, err := collectNotices(root, map[string]string{}); err == nil {
				t.Fatal("invalid evidence accepted")
			}
		})
	}
	t.Run("outside-link", func(t *testing.T) {
		root := t.TempDir()
		outside := filepath.Join(t.TempDir(), "private.txt")
		if err := os.WriteFile(outside, []byte("Not a module notice"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(outside, filepath.Join(root, "LICENSE")); err != nil {
			t.Fatal(err)
		}
		if _, err := collectNotices(root, map[string]string{}); err == nil || !strings.Contains(err.Error(), "escapes") {
			t.Fatalf("outside notice was not rejected: %v", err)
		}
	})
}

func TestBinaryModulesRequireExactMetadata(t *testing.T) {
	cache := t.TempDir()
	dir := filepath.Join(cache, "module@v1.0.0")
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	selected := &debug.Module{Path: "example.org/module", Version: "v1.0.0", Sum: "h1:locked"}
	valid := goModule{Path: selected.Path, Version: selected.Version, Sum: selected.Sum, Dir: dir}
	if err := validateModule(selected, valid, cache); err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{"path", "version", "sum", "missing-dir", "outside-cache", "replacement"} {
		t.Run(field, func(t *testing.T) {
			metadata := valid
			switch field {
			case "path":
				metadata.Path += "other"
			case "version":
				metadata.Version = "v1.0.1"
			case "sum":
				metadata.Sum = "h1:different"
			case "missing-dir":
				metadata.Dir = ""
			case "outside-cache":
				metadata.Dir = t.TempDir()
			case "replacement":
				metadata.Replace = &goModule{Path: "example.org/other"}
			}
			if err := validateModule(selected, metadata, cache); err == nil {
				t.Fatal("unrelated module sources accepted")
			}
		})
	}
	selected.Replace = &debug.Module{Path: "example.org/other"}
	if err := validateModule(selected, valid, cache); err == nil {
		t.Fatal("binary replacement accepted without review")
	}
}

func TestMissingNoticeStaysMissing(t *testing.T) {
	files, err := collectNotices(t.TempDir(), map[string]string{})
	if err != nil || files == nil || len(files) != 0 {
		t.Fatalf("missing evidence changed: %v %v", files, err)
	}
}

func TestQualifiedNoticesAcrossRootAndNestedScopes(t *testing.T) {
	root := t.TempDir()
	text := "\ufeffCopyright © Component authors\r\nFull permission and disclaimer\r\n"
	names := []string{"testify.LICENSE", "third-party.COPYING.txt", "src/vendor/example/org/component.COPYRIGHT", "misc/tools/Library.V2.NOTICE.md"}
	for _, name := range names {
		path := filepath.Join(root, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	for _, name := range []string{"testify.LICENSE.go", "testify.LICENSE.zip", "testify.LICENSE.bak", "component.notice_test.go", "LICENSE.json", ".LICENSE", "unlicensed.go"} {
		if err := os.WriteFile(filepath.Join(root, name), []byte{0xff}, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	for _, check := range []struct {
		collect func(string, map[string]string) (sourceNoticeInventory, error)
		want    int
	}{{collectSDKSourceNotices, 1}, {collectSDKOtherNotices, 1}, {collectModuleNestedNotices, 2}} {
		notices := map[string]string{}
		inventory, err := check.collect(root, notices)
		if err != nil || len(inventory.Files) != check.want || len(notices) != 1 {
			t.Fatalf("qualified nested notice missing: %+v %v", inventory, err)
		}
		for _, file := range inventory.Files {
			if notices[file.SHA256] != text || file.SHA256 != digest([]byte(text)) {
				t.Fatal("qualified notice bytes changed")
			}
		}
	}
	notices := map[string]string{}
	files, err := collectNotices(root, notices)
	if err != nil || len(files) != 2 || len(notices) != 1 {
		t.Fatalf("qualified root notice missing: %+v %v", files, err)
	}
	for _, file := range files {
		if notices[file.SHA256] != text || file.SHA256 != digest([]byte(text)) {
			t.Fatal("qualified root notice bytes changed")
		}
	}
	// A recognized, corrupt qualified notice must fail instead of disappearing
	// behind a valid root license or being relabelled as missing evidence.
	if err := os.WriteFile(filepath.Join(root, "src", "vendor", "bad.LICENSE"), []byte{0xff}, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := collectModuleNestedNotices(root, map[string]string{}); err == nil {
		t.Fatal("invalid qualified notice was ignored")
	}
}

func TestSDKSourceNoticePathsAndExactBytes(t *testing.T) {
	root := t.TempDir()
	text := "\ufeff© Вложенный автор\r\nFull permission and disclaimer\r\n"
	names := []string{"src/crypto/internal/example/LICENSE", "src/vendor/example.org/module/PATENTS", "src/cmd/vendor/other/NOTICE.txt"}
	for _, name := range names {
		path := filepath.Join(root, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(root, "LICENSE"), []byte("Root collected separately"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "src", "notice.go"), []byte("Not a notice"), 0o600); err != nil {
		t.Fatal(err)
	}
	alias := filepath.Join(root, "src", "vendor", "example.org", "module", "LICENSE")
	if err := os.Symlink(filepath.Join(root, filepath.FromSlash(names[0])), alias); err != nil {
		t.Fatal(err)
	}
	notices := map[string]string{}
	r, err := collectSDKSourceNotices(root, notices)
	if err != nil || r.Scope != "all-go-sdk-src-notice-files" || len(r.Files) != 4 || len(notices) != 1 {
		t.Fatalf("%+v %v", r, err)
	}
	if r.Files[0].Name != names[2] || r.Files[1].Name != names[0] || r.Files[2].Name != "src/vendor/example.org/module/LICENSE" || r.Files[3].Name != names[1] {
		t.Fatalf("paths/order changed: %+v", r.Files)
	}
	data, err := json.Marshal(notices)
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]string
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatal(err)
	}
	for _, file := range r.Files {
		if file.SHA256 != digest([]byte(text)) || decoded[file.SHA256] != text {
			t.Fatal("nested notice bytes changed")
		}
	}
}

func TestSDKSourceNoticeRefusals(t *testing.T) {
	for _, kind := range []string{"missing-src", "src-file", "empty", "invalid-utf8", "oversized", "outside-file", "outside-directory", "inside-directory"} {
		t.Run(kind, func(t *testing.T) {
			root := t.TempDir()
			if kind != "missing-src" && kind != "src-file" {
				if err := os.MkdirAll(filepath.Join(root, "src", "vendor"), 0o700); err != nil {
					t.Fatal(err)
				}
			}
			path := filepath.Join(root, "src", "vendor", "LICENSE")
			var err error
			switch kind {
			case "src-file":
				err = os.WriteFile(filepath.Join(root, "src"), []byte("Not a directory"), 0o600)
			case "empty":
				err = os.WriteFile(path, nil, 0o600)
			case "invalid-utf8":
				err = os.WriteFile(path, []byte{0xff}, 0o600)
			case "oversized":
				err = os.WriteFile(path, []byte(strings.Repeat("a", maxNoticeBytes+1)), 0o600)
			case "outside-file":
				outside := filepath.Join(t.TempDir(), "LICENSE")
				if err = os.WriteFile(outside, []byte("Outside"), 0o600); err == nil {
					err = os.Symlink(outside, path)
				}
			case "outside-directory":
				err = os.Symlink(t.TempDir(), filepath.Join(root, "src", "external"))
			case "inside-directory":
				err = os.Symlink(filepath.Join(root, "src", "vendor"), filepath.Join(root, "src", "alias"))
			}
			if err != nil {
				t.Fatal(err)
			}
			if _, err := collectSDKSourceNotices(root, map[string]string{}); err == nil {
				t.Fatal("partial or invalid SDK inventory accepted")
			}
		})
	}
}

func TestActualSDKContainsVendoredSourceNotices(t *testing.T) {
	notices := map[string]string{}
	r, err := collectSDKSourceNotices(currentSDKRoot(t), notices)
	if err != nil {
		t.Fatal(err)
	}
	wanted := map[string]bool{"src/vendor/golang.org/x/crypto/LICENSE": false, "src/vendor/golang.org/x/crypto/PATENTS": false, "src/cmd/vendor/github.com/google/pprof/third_party/svgpan/LICENSE": false, "src/crypto/internal/boring/LICENSE": false}
	for _, file := range r.Files {
		if _, ok := wanted[file.Name]; ok {
			wanted[file.Name] = true
		}
		if filepath.IsAbs(file.Name) || strings.Contains(file.Name, "\\") || digest([]byte(notices[file.SHA256])) != file.SHA256 {
			t.Fatal("SDK report path or notice hash invalid")
		}
	}
	for name, found := range wanted {
		if !found {
			t.Fatalf("SDK notice missing: %s", name)
		}
	}
	t.Logf("Go %s: %d SDK src notices, %d distinct texts", runtime.Version(), len(r.Files), len(notices))
}

func TestNestedInventoriesKeepScopesAndRootEvidence(t *testing.T) {
	root := t.TempDir()
	texts := map[string]string{
		"LICENSE":                "Root permission\r\n",
		"src/vendor/NOTICE":      "Source permission\n",
		"lib/time/LICENSE":       "\ufeffNested © author\r\nFull permission\r\n",
		"misc/tools/COPYING.txt": "\ufeffNested © author\r\nFull permission\r\n",
		"misc/notice.go":         "Not a named notice",
	}
	for name, text := range texts {
		path := filepath.Join(root, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	notices := map[string]string{}
	other, err := collectSDKOtherNotices(root, notices)
	if err != nil || other.Scope != "go-sdk-nested-notice-files-outside-src" || len(other.Files) != 2 || len(notices) != 1 {
		t.Fatalf("%+v %v", other, err)
	}
	if other.Files[0].Name != "lib/time/LICENSE" || other.Files[1].Name != "misc/tools/COPYING.txt" {
		t.Fatal(other.Files)
	}
	for _, file := range other.Files {
		if notices[file.SHA256] != texts[file.Name] || file.SHA256 != digest([]byte(texts[file.Name])) {
			t.Fatal("nested notice bytes changed")
		}
	}
	nested, err := collectModuleNestedNotices(root, notices)
	if err != nil || nested.Scope != "all-selected-module-nested-notice-files" || len(nested.Files) != 3 {
		t.Fatalf("%+v %v", nested, err)
	}
	// Finding a nested notice must not imply a missing root license is resolved.
	if err := os.Remove(filepath.Join(root, "LICENSE")); err != nil {
		t.Fatal(err)
	}
	files, err := collectNotices(root, notices)
	if err != nil || len(files) != 0 {
		t.Fatalf("root evidence invented: %v %v", files, err)
	}
}

func TestNestedInventoriesRejectUnsafeEvidence(t *testing.T) {
	for _, kind := range []string{"empty", "oversized", "invalid-utf8", "outside-file", "outside-directory", "inside-directory", "linked-src"} {
		t.Run(kind, func(t *testing.T) {
			root := t.TempDir()
			dir := filepath.Join(root, "lib")
			if err := os.Mkdir(dir, 0o700); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(dir, "NOTICE")
			var err error
			switch kind {
			case "empty":
				err = os.WriteFile(path, nil, 0o600)
			case "oversized":
				err = os.WriteFile(path, []byte(strings.Repeat("a", maxNoticeBytes+1)), 0o600)
			case "invalid-utf8":
				err = os.WriteFile(path, []byte{0xff}, 0o600)
			case "outside-file":
				outside := filepath.Join(t.TempDir(), "private")
				if err = os.WriteFile(outside, []byte("Private"), 0o600); err == nil {
					err = os.Symlink(outside, path)
				}
			case "outside-directory":
				err = os.Symlink(t.TempDir(), filepath.Join(dir, "external"))
			case "inside-directory":
				err = os.Symlink(dir, filepath.Join(root, "alias"))
			case "linked-src":
				err = os.Symlink(t.TempDir(), filepath.Join(root, "src"))
			}
			if err != nil {
				t.Fatal(err)
			}
			for _, collect := range []func(string, map[string]string) (sourceNoticeInventory, error){collectSDKOtherNotices, collectModuleNestedNotices} {
				if _, err := collect(root, map[string]string{}); err == nil {
					t.Fatal("unsafe evidence accepted")
				}
			}
			if kind == "linked-src" {
				if _, err := collectSDKSourceNotices(root, map[string]string{}); err == nil {
					t.Fatal("linked src accepted")
				}
			}
		})
	}
}

func TestActualSDKOtherNotices(t *testing.T) {
	notices := map[string]string{}
	r, err := collectSDKOtherNotices(currentSDKRoot(t), notices)
	if err != nil {
		t.Fatal(err)
	}
	for _, file := range r.Files {
		if strings.HasPrefix(file.Name, "src/") || !strings.Contains(file.Name, "/") || digest([]byte(notices[file.SHA256])) != file.SHA256 {
			t.Fatal("wrong SDK scope or bytes")
		}
	}
	t.Logf("Go %s: %d other SDK notices, %d distinct texts", runtime.Version(), len(r.Files), len(notices))
}
