package main

import (
	"flag"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// go test ./... -update rewrites testdata/golden/ (review the diff!).
var update = flag.Bool("update", false, "rewrite golden files")

func testOptions(engine Engine, php bool, docrootExists bool) Options {
	return Options{
		Engine:           engine,
		Out:              "/run/oblimint",
		PHPFPM:           php,
		ConfigFile:       "/etc/oblimint/site/primary.json",
		DocrootExists:    func(string) bool { return docrootExists },
		ApacheModulesDir: "/usr/lib/apache2",
		ApacheMimeTypes:  "/etc/apache2/mime.types",
		NginxMimeTypes:   "/etc/nginx/mime.types",
	}
}

func mustLoad(t *testing.T, name string) *SiteConfig {
	t.Helper()
	cfg, err := LoadConfig(filepath.Join("testdata", name))
	if err != nil {
		t.Fatalf("load %s: %v", name, err)
	}
	return cfg
}

func TestGolden(t *testing.T) {
	cases := []struct {
		name    string
		config  string
		engine  Engine
		php     bool
		present bool
		links   []DataLink
	}{
		{"apache-wordpress", "wordpress.json", EngineApache, true, true, nil},
		{"apache-prestashop-typed", "prestashop.json", EngineApache, true, true, nil},
		{"apache-basepath", "laravel-blog.json", EngineApache, true, true, nil},
		// Release links into /srv/data found by the walk (datalinks.go).
		{"apache-wordpress-data-links", "wordpress.json", EngineApache, true, true, []DataLink{
			{Dir: "wp-content/uploads", DataRel: "wp-content/uploads"},
			{Dir: "media", DataRel: "wp-content/uploads"},
			{Dir: "wp-admin", DataRel: "wp-content/uploads/x.htaccess", HtaccessOnly: true},
		}},
		{"nginx-wordpress", "wordpress.json", EngineNginx, true, true, nil},
		{"nginx-laravel-basepath", "laravel-blog.json", EngineNginx, true, true, nil},
		{"nginx-prestashop-custom-root", "prestashop.json", EngineNginx, true, true, nil},
		{"static", "static.json", EngineStatic, false, true, nil},
		{"placeholder-apache", "wordpress.json", EngineApache, true, false, nil},
		{"placeholder-nginx", "laravel-blog.json", EngineNginx, true, false, nil},
		{"placeholder-static", "static.json", EngineStatic, false, false, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cfg := mustLoad(t, tc.config)
			opt := testOptions(tc.engine, tc.php, tc.present)
			if tc.links != nil {
				opt.DataLinks = func(string) ([]DataLink, []string) { return tc.links, nil }
			}
			res, err := Render(cfg, opt)
			if err != nil {
				t.Fatalf("render: %v", err)
			}
			got := map[string]string{}
			for _, f := range res.Files {
				got[f.Name] = f.Content
			}
			if len(res.Links) > 0 {
				var b strings.Builder
				for _, l := range res.Links {
					b.WriteString(l.Path + " -> " + l.Target + "\n")
				}
				got["links.txt"] = b.String()
			}
			if len(res.Warnings) > 0 {
				got["warnings.txt"] = strings.Join(res.Warnings, "\n") + "\n"
			}
			dir := filepath.Join("testdata", "golden", tc.name)
			if *update {
				_ = os.RemoveAll(dir)
				if err := os.MkdirAll(dir, 0o755); err != nil {
					t.Fatal(err)
				}
				for name, content := range got {
					if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
						t.Fatal(err)
					}
				}
				return
			}
			entries, err := os.ReadDir(dir)
			if err != nil {
				t.Fatalf("golden dir missing (run go test -update): %v", err)
			}
			want := map[string]string{}
			for _, e := range entries {
				b, err := os.ReadFile(filepath.Join(dir, e.Name()))
				if err != nil {
					t.Fatal(err)
				}
				want[e.Name()] = strings.ReplaceAll(string(b), "\r\n", "\n")
			}
			for name, w := range want {
				g, ok := got[name]
				if !ok {
					t.Errorf("%s: expected file not rendered", name)
					continue
				}
				if g != w {
					t.Errorf("%s differs from golden:\n%s", name, firstDiff(w, g))
				}
			}
			for name := range got {
				if _, ok := want[name]; !ok {
					t.Errorf("%s: rendered but not in golden", name)
				}
			}
		})
	}
}

func firstDiff(want, got string) string {
	wl, gl := strings.Split(want, "\n"), strings.Split(got, "\n")
	for i := 0; i < len(wl) || i < len(gl); i++ {
		var w, g string
		if i < len(wl) {
			w = wl[i]
		}
		if i < len(gl) {
			g = gl[i]
		}
		if w != g {
			return "line " + itoa(i+1) + ":\n  want: " + w + "\n  got:  " + g
		}
	}
	return "(no line difference)"
}

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	var b []byte
	for ; i > 0; i /= 10 {
		b = append([]byte{byte('0' + i%10)}, b...)
	}
	return string(b)
}

// ── Security properties, asserted directly (independent of the goldens) ─────

func renderFile(t *testing.T, cfg *SiteConfig, opt Options, name string) string {
	t.Helper()
	res, err := Render(cfg, opt)
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	for _, f := range res.Files {
		if f.Name == name {
			return f.Content
		}
	}
	t.Fatalf("%s not rendered", name)
	return ""
}

func TestApacheDataPathsNeverRunPHP(t *testing.T) {
	cfg := mustLoad(t, "wordpress.json")
	conf := renderFile(t, cfg, testOptions(EngineApache, true, true), "httpd.conf")
	mustContain(t, conf,
		`<Directory "/srv/data">`,
		`<Directory "/srv/releases/current/wp-content/uploads">`,
		`<DirectoryMatch "^/srv/releases/[^/]+/wp-content/uploads(/|$)">`,
		`<If "-f %{REQUEST_FILENAME} && %{REQUEST_FILENAME} !~ m#^/srv/(?:data/|releases/[^/]+/(?:wp-content/cache|wp-content/upgrade|wp-content/uploads)(?:/|$))#">`,
		`SetHandler "proxy:unix:/run/php-fpm.sock|fcgi://localhost"`,
		"Options -ExecCGI",
		"SetHandler None",
		"AllowOverride All",
	)
	// Every data-path section disables .htaccess and denies PHP-like files.
	if n := strings.Count(conf, `<FilesMatch "(?i)\.(php[0-9]?|phar|phtml|pht|phps)$">`); n != 1+2*3 {
		t.Errorf("expected 7 PHP deny blocks, got %d", n)
	}
	if strings.Count(conf, "AllowOverride None") < 1+1+3 {
		t.Errorf("data paths must have AllowOverride None")
	}
}

func TestApacheTypedWhitelist(t *testing.T) {
	cfg := mustLoad(t, "prestashop.json")
	conf := renderFile(t, cfg, testOptions(EngineApache, true, true), "httpd.conf")
	mustContain(t, conf, `<FilesMatch "(?i)\.(jpeg|jpg|png|svg|webp)$">`)
	// Typed path without extensions: everything denied, no grant block.
	i := strings.Index(conf, `<Directory "/srv/releases/current/themes/cache">`)
	j := strings.Index(conf[i:], "</Directory>")
	block := conf[i : i+j]
	if !strings.Contains(block, "Require all denied") || strings.Contains(block, "Require all granted") {
		t.Errorf("typed path without extensions must deny everything:\n%s", block)
	}
}

func TestNginxDataPathLocations(t *testing.T) {
	cfg := mustLoad(t, "laravel-blog.json")
	conf := renderFile(t, cfg, testOptions(EngineNginx, true, true), "nginx.conf")
	mustContain(t, conf,
		"location ^~ /blog/media/ {",
		"location ^~ /blog/user@files/ {",
		`location ~* \.(jpg|png)$ {`,
		"# Data path storage (persistent): outside the docroot, not web-reachable.",
		"root /run/oblimint/www;",
		"include /run/oblimint/custom.conf;",
		"# location /blog/ is defined by the custom rules.",
		"location / {\n            return 404;",
	)
	// No fastcgi inside a data-path location.
	i := strings.Index(conf, "location ^~ /blog/media/ {")
	j := strings.Index(conf[i:], "\n        }\n")
	if strings.Contains(conf[i:i+j], "fastcgi") {
		t.Errorf("fastcgi inside a data path location:\n%s", conf[i:i+j])
	}
	// The typed path ends with a catch-all 403.
	if !strings.Contains(conf[i:i+j], "            return 403;") {
		t.Errorf("typed data path without final return 403")
	}
}

func TestBasePathLinks(t *testing.T) {
	cfg := mustLoad(t, "laravel-blog.json")
	res, err := Render(cfg, testOptions(EngineNginx, true, true))
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Links) != 1 || res.Links[0].Path != "www/blog" || res.Links[0].Target != "/srv/releases/current/public" {
		t.Fatalf("unexpected links %+v", res.Links)
	}
	// Apache uses Alias, never links.
	res, err = Render(cfg, testOptions(EngineApache, true, true))
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Links) != 0 {
		t.Fatalf("apache must not create links: %+v", res.Links)
	}
}

func TestPHPFPMPool(t *testing.T) {
	cfg := mustLoad(t, "prestashop.json")
	pool := renderFile(t, cfg, testOptions(EngineApache, true, true), "php-fpm.conf")
	mustContain(t, pool,
		"security.limit_extensions = .php",
		"php_admin_value[open_basedir] = /srv/releases/:/srv/data/:/tmp/:/opt/oblimint/",
		"php_admin_value[auto_prepend_file] = /opt/oblimint/guard.php",
		"php_admin_value[session.save_path] = /tmp/sessions",
		"php_value[memory_limit] = 512M",
		"php_value[upload_max_filesize] = 32M",
		"php_value[post_max_size] = 48M",
		"php_value[max_execution_time] = 120",
		"listen = /run/php-fpm.sock",
		"pid = /run/oblimint/php-fpm.pid",
		"request_terminate_timeout = 150s",
		// The site environment variables reach PHP; libpq still finds the default PostgreSQL socket.
		"clear_env = no",
		"env[PGHOST] = /run/postgresql",
	)
	if strings.Contains(pool, "\nuser =") || strings.Contains(pool, "\ngroup =") {
		t.Error("the pool must not set user/group (non-root master)")
	}
}

func TestPlaceholder(t *testing.T) {
	cfg := mustLoad(t, "wordpress.json")
	res, err := Render(cfg, testOptions(EngineApache, true, false))
	if err != nil {
		t.Fatal(err)
	}
	if !res.Placeholder {
		t.Fatal("expected placeholder mode")
	}
	var conf string
	var marker bool
	for _, f := range res.Files {
		if f.Name == "httpd.conf" {
			conf = f.Content
		}
		if f.Name == placeholderMarker {
			marker = true
		}
	}
	if !marker {
		t.Error("placeholder marker not rendered")
	}
	mustContain(t, conf, "RewriteRule ^ - [R=503,L]", "ErrorDocument 503 /__oblimint/placeholder.html", `Header always set Retry-After "30"`)
	if strings.Contains(conf, "proxy:unix") {
		t.Error("placeholder mode must not route anything to PHP")
	}

	cfg = mustLoad(t, "laravel-blog.json")
	res, err = Render(cfg, testOptions(EngineNginx, true, false))
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range res.Files {
		if f.Name == "nginx.conf" {
			if strings.Contains(f.Content, "fastcgi_pass") || strings.Contains(f.Content, "custom.conf") {
				t.Error("nginx placeholder must not use PHP nor the custom rules")
			}
			mustContain(t, f.Content, "return 503;", "add_header Retry-After 30 always;")
		}
	}
	if len(res.Links) != 0 {
		t.Error("no basePath tree in placeholder mode")
	}
}

func TestPingEverywhere(t *testing.T) {
	for _, tc := range []struct {
		cfg    string
		engine Engine
		php    bool
		file   string
		want   string
	}{
		{"wordpress.json", EngineApache, true, "httpd.conf", `Alias "/__oblimint/" "/usr/share/oblimint/"`},
		{"wordpress.json", EngineNginx, true, "nginx.conf", "location = /__oblimint/ping {"},
		{"static.json", EngineStatic, false, "nginx.conf", `return 200 "ok";`},
	} {
		for _, present := range []bool{true, false} {
			conf := renderFile(t, mustLoad(t, tc.cfg), testOptions(tc.engine, tc.php, present), tc.file)
			mustContain(t, conf, tc.want)
		}
	}
}

func TestStaticNeverServesPHP(t *testing.T) {
	conf := renderFile(t, mustLoad(t, "static.json"), testOptions(EngineStatic, false, true), "nginx.conf")
	mustContain(t, conf, `location ~* \.(php[0-9]?|phar|phtml|pht|phps|inc)(/|$) {`, "try_files $uri $uri/ =404;")
	if strings.Contains(conf, "fastcgi_pass") || strings.Contains(conf, "php-fpm.sock") {
		t.Error("static config must not reference php-fpm")
	}
	if _, err := Render(mustLoad(t, "static.json"), testOptions(EngineStatic, true, true)); err == nil {
		t.Error("static + php-fpm must be refused")
	}
}

func TestEngineMismatchWarns(t *testing.T) {
	res, err := Render(mustLoad(t, "wordpress.json"), testOptions(EngineNginx, true, true))
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Warnings) == 0 || !strings.Contains(res.Warnings[0], "expects the apache engine") {
		t.Errorf("expected a mismatch warning, got %v", res.Warnings)
	}
}

func TestInvalidOptions(t *testing.T) {
	cfg := mustLoad(t, "wordpress.json")
	for _, out := range []string{"", "run/oblimint", "/run/../etc", "/run/obli mint", "/run/x\"y"} {
		opt := testOptions(EngineApache, true, true)
		opt.Out = out
		if _, err := Render(cfg, opt); err == nil {
			t.Errorf("out %q accepted", out)
		}
	}
	opt := testOptions("lighttpd", false, true)
	if _, err := Render(cfg, opt); err == nil {
		t.Error("unknown engine accepted")
	}
	opt = testOptions(EngineApache, true, true)
	opt.ApacheModulesDir = "/usr/lib/apache2\"\nLoadModule evil /tmp/x.so"
	if _, err := Render(cfg, opt); err == nil {
		t.Error("unsafe modules dir accepted")
	}
}

func mustContain(t *testing.T, s string, parts ...string) {
	t.Helper()
	for _, p := range parts {
		if !strings.Contains(s, p) {
			t.Errorf("missing %q", p)
		}
	}
}

func TestNginxPHPNeverSourceDisclosesVariants(t *testing.T) {
	for _, name := range []string{"laravel-blog.json", "wordpress.json", "prestashop.json"} {
		conf := renderFile(t, mustLoad(t, name), testOptions(EngineNginx, true, true), "nginx.conf")
		deny := "location ~* \\.(php[0-9]|phar|phtml|pht|phps)(/|$) {\n            return 403;"
		php := `location ~ [^/]\.php(/|$) {`
		i, j := strings.Index(conf, php), strings.Index(conf, deny)
		if i < 0 || j < 0 {
			t.Errorf("%s: missing PHP location (%d) or PHP-variant deny (%d)", name, i, j)
			continue
		}
		// After the PHP location: /index.php/x.phtml (PATH_INFO) still reaches php-fpm.
		if j < i {
			t.Errorf("%s: PHP-variant deny must come after the PHP location", name)
		}
	}
}
