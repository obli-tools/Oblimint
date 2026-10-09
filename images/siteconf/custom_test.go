package main

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func strp(s string) *string { return &s }

func TestCustomNginxAccepted(t *testing.T) {
	cases := map[string][]string{
		"location / { try_files $uri $uri/ /index.php?$args; }":                     {"/"},
		"location ~* \\.(css|js)$ { expires 7d; }\nlocation = /x { return 204; }\n": {`~* \.(css|js)$`, "= /x"},
		"add_header X-Test \"a { b } ; c\";":                                        nil,
		"add_header X-Test 'it''s';":                                                nil,
		"# only a comment with } and {\n":                                           nil,
		"set $x \"${host}\";\nreturn 301 https://${host}$request_uri;":              nil,
		"location /a/ {\n  location ~ \\.png$ { expires 1d; }\n}\n":                 {"/a/"},
		"if ($request_uri ~ \"^/old\") { return 301 /new; }":                        nil,
		"return 200 ${request_uri}x${host};":                                        nil,
		"location /p { return 200 a}b; }":                                           {"/p"},
	}
	for in, locs := range cases {
		r := CheckCustomNginx(strp(in))
		if r.Rejected != "" {
			t.Errorf("%q rejected: %s", in, r.Rejected)
			continue
		}
		if !strings.HasSuffix(r.Content, "\n") {
			t.Errorf("%q: content must end with a newline", in)
		}
		if strings.Join(r.TopLocations, "|") != strings.Join(locs, "|") {
			t.Errorf("%q: locations %q, want %q", in, r.TopLocations, locs)
		}
	}
	if r := CheckCustomNginx(nil); r.Content != "" || r.Rejected != "" {
		t.Error("nil must be empty")
	}
	if r := CheckCustomNginx(strp("  \n\t")); r.Content != "" || r.Rejected != "" {
		t.Error("blank must be empty")
	}
}

func TestCustomNginxRejected(t *testing.T) {
	cases := []string{
		// Closing the server block and appending a second server.
		"} server { listen 8081; root /; } server {",
		"}",
		"location / { return 200;",
		"location / { return 200; }}",
		"return 200",
		"add_header X \"unterminated;",
		"add_header X 'unterminated;",
		"include /etc/passwd;",
		"location / { include /etc/oblimint/site/primary.json; }",
		"load_module /tmp/x.so;",
		"return 200 \"a\x00b\";",
		"return 200 \"a\x1bb\";",
		"{ return 200; }",
		";",
		"set $x ${host;",
		// nginx ends a word at ';' / '{' / space even after "${": the lexer must not
		// swallow them (that hid an include and a whole block from the checks).
		"location /a {\n default_type ${x; include /etc/nginx/fastcgi_params; location = /d { default_type ${y;} location = /e { }\n}\n",
		"set $x ${a;b};",
		"set $x ${};",
		"set $x ${a b};",
		"set $x ${a{b}};",
		// A '}' glued to a word does not close a block (nginx keeps it in the word).
		"location / { return 200 x}",
		strings.Repeat("#", maxCustomNginxBytes+1),
		"return 200 \"\xff\xfe\";",
	}
	for _, in := range cases {
		r := CheckCustomNginx(strp(in))
		if r.Rejected == "" || r.Content != "" {
			t.Errorf("%q accepted", truncate(in))
		}
	}
}

func TestCustomRejectedStillRenders(t *testing.T) {
	cfg := mustLoad(t, "laravel-blog.json")
	cfg.CustomNginx = strp("} server { listen 9999; }")
	res, err := Render(cfg, testOptions(EngineNginx, true, true))
	if err != nil {
		t.Fatalf("a bad custom rule set must not block the render: %v", err)
	}
	if res.CustomRejected == "" {
		t.Fatal("expected CustomRejected")
	}
	for _, f := range res.Files {
		switch f.Name {
		case "custom.conf":
			if !strings.HasPrefix(f.Content, "# Custom nginx rules DISABLED") || strings.Contains(f.Content, "9999") {
				t.Errorf("custom.conf must only hold the reason: %q", f.Content)
			}
		case "nginx.conf":
			if strings.Contains(f.Content, "custom.conf") {
				t.Error("rejected custom rules must not be included")
			}
			mustContain(t, f.Content, "location /blog/ {\n            try_files")
		}
	}
}

func TestRenderRefusesInjection(t *testing.T) {
	inject := []func(c *SiteConfig){
		func(c *SiteConfig) { c.Docroot = "/srv/releases/current/x\"\n<Directory />\nRequire all granted" },
		func(c *SiteConfig) { c.Docroot = "/srv/releases/current/x;}server{" },
		func(c *SiteConfig) { c.BasePath = "/a\"/" },
		func(c *SiteConfig) { c.BasePath = "/a;/" },
		func(c *SiteConfig) { c.BasePath = "/a}/" },
		func(c *SiteConfig) { c.BasePath = "/a\n/" },
		func(c *SiteConfig) { c.DataPaths[0].Path = "uploads\"#" },
		func(c *SiteConfig) { c.DataPaths[0].Path = "uploads/;deny all" },
		func(c *SiteConfig) { c.DataPaths[0].Path = "uploads}" },
		func(c *SiteConfig) { c.DataPaths[0].Path = "uploads\n" },
		func(c *SiteConfig) {
			c.DataPaths[0].Policy = PolicyTyped
			c.DataPaths[0].AllowedExtensions = []string{"jpg)$\">\nSetHandler"}
		},
		func(c *SiteConfig) {
			c.DataPaths[0].Policy = PolicyTyped
			c.DataPaths[0].AllowedExtensions = []string{"jpg;"}
		},
		func(c *SiteConfig) {
			c.DataPaths[0].Policy = PolicyTyped
			c.DataPaths[0].AllowedExtensions = []string{"jp}g"}
		},
		func(c *SiteConfig) { c.Role = "primary\nListen 80" },
		func(c *SiteConfig) { c.Base = "apache-php8.3\"" },
	}
	for i, mutate := range inject {
		cfg := mustLoad(t, "wordpress.json")
		mutate(cfg)
		for _, e := range []Engine{EngineApache, EngineNginx} {
			if _, err := Render(cfg, testOptions(e, true, true)); err == nil {
				t.Errorf("injection %d accepted by %s", i, e)
			}
		}
	}
}

func TestQuotingHelpers(t *testing.T) {
	for _, bad := range []string{"", "a b", `a"b`, "a\nb", "a;b", "a{b", "a}b", "a#b", "a$b", "a'b", `a\b`} {
		if _, err := aq(bad); err == nil {
			t.Errorf("aq(%q) accepted", bad)
		}
		if _, err := ns(bad); err == nil {
			t.Errorf("ns(%q) accepted", bad)
		}
	}
	if v, err := aq("/srv/releases/current/user@files+x"); err != nil || v != `"/srv/releases/current/user@files+x"` {
		t.Errorf("aq: %q %v", v, err)
	}
	if v, err := pathRegex("a.b/c+d@e-f_g"); err != nil || v != `a\.b/c\+d@e-f_g` {
		t.Errorf("pathRegex: %q %v", v, err)
	}
	if _, err := joinExt([]string{"jpg", "p|hp"}, "|"); err == nil {
		t.Error("joinExt accepted an unsafe extension")
	}
}

// ── CLI + writer ─────────────────────────────────────────────────────────────

func TestCLIRenderAndCheck(t *testing.T) {
	root := t.TempDir()
	// Simulated container filesystem: the release exists.
	if err := os.MkdirAll(filepath.Join(root, "srv", "releases", "current"), 0o755); err != nil {
		t.Fatal(err)
	}
	cfgPath, _ := filepath.Abs(filepath.Join("testdata", "wordpress.json"))
	var out, errb strings.Builder
	code := run([]string{"render", "--config", cfgPath, "--engine", "apache", "--out", "/run/oblimint", "--php-fpm", "--fs-root", root}, &out, &errb)
	if code != 0 {
		t.Fatalf("render exit %d: %s", code, errb.String())
	}
	if strings.TrimSpace(out.String()) != "mode=site" {
		t.Errorf("stdout %q", out.String())
	}
	for _, f := range []string{"httpd.conf", "php-fpm.conf"} {
		if _, err := os.Stat(filepath.Join(root, "run", "oblimint", f)); err != nil {
			t.Errorf("%s not written: %v", f, err)
		}
	}
	if _, err := os.Stat(filepath.Join(root, "run", "oblimint", placeholderMarker)); !os.IsNotExist(err) {
		t.Error("placeholder marker must not exist")
	}

	// Placeholder: the release disappears → marker written, then removed again.
	if err := os.RemoveAll(filepath.Join(root, "srv")); err != nil {
		t.Fatal(err)
	}
	out.Reset()
	if code := run([]string{"render", "--config", cfgPath, "--engine", "apache", "--out", "/run/oblimint", "--php-fpm", "--fs-root", root}, &out, &errb); code != 0 {
		t.Fatalf("exit %d", code)
	}
	if strings.TrimSpace(out.String()) != "mode=placeholder" {
		t.Errorf("stdout %q", out.String())
	}
	if _, err := os.Stat(filepath.Join(root, "run", "oblimint", placeholderMarker)); err != nil {
		t.Error("placeholder marker missing")
	}

	out.Reset()
	if code := run([]string{"check", "--config", cfgPath}, &out, &errb); code != 0 || strings.TrimSpace(out.String()) != "ok" {
		t.Errorf("check: %d %q", code, out.String())
	}

	// Invalid config → exit 1, nothing (re)written.
	bad := filepath.Join(t.TempDir(), "bad.json")
	if err := os.WriteFile(bad, []byte(`{"version":1,"siteId":1,"accountId":1,"role":"primary","base":"nginx-php8.3","docroot":"/etc","basePath":"/"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	empty := t.TempDir()
	errb.Reset()
	if code := run([]string{"render", "--config", bad, "--engine", "nginx", "--out", "/run/oblimint", "--fs-root", empty}, &out, &errb); code != 1 {
		t.Errorf("invalid config exit %d", code)
	}
	if !strings.Contains(errb.String(), "docroot") {
		t.Errorf("stderr %q", errb.String())
	}
	if _, err := os.Stat(filepath.Join(empty, "run")); !os.IsNotExist(err) {
		t.Error("an invalid config must not write anything")
	}
	if code := run([]string{"check", "--config", bad}, &out, &errb); code != 1 {
		t.Errorf("check invalid exit %d", code)
	}
	if code := run([]string{"bogus"}, &out, &errb); code != 2 {
		t.Errorf("usage exit %d", code)
	}
	if code := run([]string{"render", "--engine", "nginx"}, &out, &errb); code != 2 {
		t.Errorf("missing config exit %d", code)
	}
}

func TestCLINoCustom(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "srv", "releases", "current", "dist"), 0o755); err != nil {
		t.Fatal(err)
	}
	cfgPath, _ := filepath.Abs(filepath.Join("testdata", "static.json"))
	var out, errb strings.Builder
	if code := run([]string{"render", "--config", cfgPath, "--engine", "static", "--out", "/run/oblimint", "--no-custom", "--fs-root", root}, &out, &errb); code != 0 {
		t.Fatalf("exit %d: %s", code, errb.String())
	}
	b, err := os.ReadFile(filepath.Join(root, "run", "oblimint", "custom.conf"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b), "old-page") {
		t.Error("--no-custom must drop the custom rules")
	}
	conf, _ := os.ReadFile(filepath.Join(root, "run", "oblimint", "nginx.conf"))
	if strings.Contains(string(conf), "include /run/oblimint/custom.conf") {
		t.Error("--no-custom must not include custom.conf")
	}
}

func TestWriteLinks(t *testing.T) {
	dir := t.TempDir()
	target := t.TempDir()
	res := &Output{
		Files: []OutFile{{Name: "nginx.conf", Content: "x"}},
		Links: []OutLink{{Path: "www/a/blog", Target: target}},
	}
	if err := WriteOutput(dir, res); err != nil {
		if runtime.GOOS == "windows" {
			t.Skipf("symlinks unavailable on this Windows box: %v", err)
		}
		t.Fatal(err)
	}
	got, err := os.Readlink(filepath.Join(dir, "www", "a", "blog"))
	if err != nil || got != target {
		t.Fatalf("link %q %v", got, err)
	}
	// Re-render without links: the tree goes away.
	if err := WriteOutput(dir, &Output{Files: res.Files}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(filepath.Join(dir, "www")); !os.IsNotExist(err) {
		t.Error("www must be removed")
	}
}

func TestWriteRefusesUnsafeNames(t *testing.T) {
	dir := t.TempDir()
	for _, res := range []*Output{
		{Files: []OutFile{{Name: "../evil", Content: "x"}}},
		{Files: []OutFile{{Name: "/etc/evil", Content: "x"}}},
		{Links: []OutLink{{Path: "elsewhere/x", Target: "/"}}},
		{Links: []OutLink{{Path: "www/../../x", Target: "/"}}},
	} {
		if err := WriteOutput(dir, res); err == nil {
			t.Errorf("unsafe output accepted: %+v", res)
		}
	}
}
