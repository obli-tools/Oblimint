package main

import (
	"regexp"
	"sort"
	"strings"
	"testing"
)

// ── litespeed bases (OpenLiteSpeed + lsphp): security properties ───────────

func renderLS(t *testing.T, cfg *SiteConfig, opt Options) map[string]string {
	t.Helper()
	res, err := Render(cfg, opt)
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	got := map[string]string{}
	for _, f := range res.Files {
		got[f.Name] = f.Content
	}
	return got
}

var lsContextRE = regexp.MustCompile(`(?m)^context (\S+) \{`)

// contextURIs: the context URIs of a vhost.conf, in OpenLiteSpeed's matching
// order for the regex ones (HttpVHost::configVHContextList sorts by URI).
func contextURIs(vhost string) (all []string, regex []string) {
	for _, m := range lsContextRE.FindAllStringSubmatch(vhost, -1) {
		all = append(all, m[1])
		if strings.HasPrefix(m[1], "exp:") {
			regex = append(regex, m[1])
		}
	}
	sort.Strings(regex)
	return all, regex
}

// firstMatch: the context OpenLiteSpeed picks among the root regex contexts.
func firstMatch(t *testing.T, regex []string, uri string) string {
	t.Helper()
	for _, r := range regex {
		if r == "exp:"+lsHiddenRegex {
			// Go's regexp has no look-ahead: the same rule, by hand.
			if hiddenMatch(uri) {
				return r
			}
			continue
		}
		re, err := regexp.Compile(strings.TrimPrefix(r, "exp:"))
		if err != nil {
			t.Fatalf("context %s: %v", r, err)
		}
		if re.MatchString(uri) {
			return r
		}
	}
	return ""
}

// hiddenMatch: (?:/.(?!well-known(/|$))) — a "/." not starting "/.well-known".
func hiddenMatch(uri string) bool {
	for i := 0; i+1 < len(uri); i++ {
		if uri[i] != '/' || uri[i+1] != '.' {
			continue
		}
		rest := uri[i+2:]
		if rest == "well-known" || strings.HasPrefix(rest, "well-known/") {
			continue
		}
		return true
	}
	return false
}

func contextBlock(t *testing.T, vhost, uri string) string {
	t.Helper()
	i := strings.Index(vhost, "context "+uri+" {")
	if i < 0 {
		t.Fatalf("context %s not rendered", uri)
	}
	j := strings.Index(vhost[i:], "\n}\n")
	return vhost[i : i+j+3]
}

func TestLitespeedFilesAndPHP(t *testing.T) {
	cfg := mustLoad(t, "litespeed-wordpress.json")
	got := renderLS(t, cfg, testOptions(EngineLitespeed, true, true))
	for _, name := range []string{"lsws/httpd_config.conf", "lsws/vhost.conf", "lsphp/site.ini"} {
		if _, ok := got[name]; !ok {
			t.Fatalf("%s not rendered", name)
		}
	}
	for _, name := range []string{"php-fpm.conf", "httpd.conf", "nginx.conf", "custom.conf"} {
		if _, ok := got[name]; ok {
			t.Errorf("%s rendered for a litespeed base", name)
		}
	}
	ini := got["lsphp/site.ini"]
	mustContain(t, ini,
		"open_basedir = /srv/releases/:/srv/data/:/tmp/:/opt/oblimint/",
		"auto_prepend_file = /opt/oblimint/guard.php",
		`oblimint.exec_dirs = "/srv/releases/:/opt/oblimint/:/srv/data/wp-content/cache/:/srv/data/wp-content/upgrade/"`,
		"allow_url_include = Off",
		"memory_limit = 256M",
	)
	if strings.Contains(ini, "uploads") {
		t.Errorf("user content must never be in oblimint.exec_dirs:\n%s", ini)
	}
	conf := got["lsws/httpd_config.conf"]
	mustContain(t, conf,
		"address                 uds://run/oblimint/lsphp.sock",
		"autoStart               0",
		"add                     lsapi:lsphp php",
		"quicEnable              0",
		"disableWebAdmin             1",
		"address                 *:8080",
		"restrained              0",
		"storagePath             /var/cache/lscache/g1/pages",
		"gzipCacheDir            /var/cache/lscache/g1/static",
		"checkPrivateCache       1",
		"enablePrivateCache      0",
		"enableCache             0",
	)
	// Only .php is handed to lsphp.
	if n := strings.Count(conf, "lsapi:lsphp"); n != 1 {
		t.Errorf("expected one script handler, got %d", n)
	}
}

func TestLitespeedDataPathsNeverRunPHPNorReadHtaccess(t *testing.T) {
	cfg := mustLoad(t, "litespeed-wordpress.json")
	vhost := renderLS(t, cfg, testOptions(EngineLitespeed, true, true))["lsws/vhost.conf"]
	all, regex := contextURIs(vhost)
	for _, u := range all {
		// A prefix context would make OpenLiteSpeed walk the data directory and
		// load its .htaccess (HttpVHost::bestMatch): data paths use regex only.
		if strings.HasPrefix(u, "/wp-content") {
			t.Errorf("prefix context %s for a data path", u)
		}
	}
	cases := map[string]string{
		"/wp-content/uploads/shell.php":      "deny",
		"/wp-content/uploads/2026/x.PHP":     "deny",
		"/wp-content/uploads/a.phtml":        "deny",
		"/wp-content/uploads/a.php/x":        "deny",
		"/wp-content/uploads/.htaccess":      "deny",
		"/wp-content/uploads/2026/photo.jpg": "data",
		"/wp-content/cache/page.html":        "data",
		"/x.phtml":                           "deny",
		"/.env":                              "deny",
		"/.git/config":                       "deny",
		"/wp-login.php":                      "",
		"/index.php":                         "",
		"/.well-known/acme-challenge/x":      "",
		"/wp-content/themes/t/style.css":     "",
	}
	for uri, want := range cases {
		m := firstMatch(t, regex, uri)
		switch want {
		case "":
			if m != "" {
				t.Errorf("%s: matched %s, expected the normal release mapping", uri, m)
			}
		case "deny":
			if m == "" || !strings.Contains(contextBlock(t, vhost, m), "allowBrowse             0") {
				t.Errorf("%s: expected a refusing context, got %q", uri, m)
			}
		case "data":
			b := ""
			if m != "" {
				b = contextBlock(t, vhost, m)
			}
			if !strings.Contains(b, "allowBrowse             1") || !strings.Contains(b, "enable              0") || !strings.Contains(b, "location                /srv/releases/current/wp-content/") {
				t.Errorf("%s: expected the data context (served, rewrite off), got %q:\n%s", uri, m, b)
			}
		}
	}
}

func TestLitespeedTypedWhitelist(t *testing.T) {
	cfg := mustLoad(t, "litespeed-prestashop.json")
	vhost := renderLS(t, cfg, testOptions(EngineLitespeed, true, true))["lsws/vhost.conf"]
	_, regex := contextURIs(vhost)
	allow := func(uri string) bool {
		m := firstMatch(t, regex, uri)
		return m != "" && strings.Contains(contextBlock(t, vhost, m), "allowBrowse             1")
	}
	for uri, want := range map[string]bool{
		"/img/p/1.jpg":         true,
		"/img/p/1.JPG":         true,
		"/img/p/1.webp":        true,
		"/img/p/1.gif":         false,
		"/img/p/1.php":         false,
		"/img/p/.hidden.png":   false,
		"/img/p/x.php/y.png":   true, // a "file" under a .php FILE: 404 (served statically, never executed)
		"/themes/cache/a.css":  false,
		"/upload/f.pdf":        true,
		"/var/cache/prod/x.js": true,
	} {
		if got := allow(uri); got != want {
			t.Errorf("%s: served=%v, want %v", uri, got, want)
		}
	}
}

func TestLitespeedLSCacheSwitch(t *testing.T) {
	on := mustLoad(t, "litespeed-wordpress.json")
	off := mustLoad(t, "litespeed-prestashop.json")
	absent := mustLoad(t, "litespeed-laravel-blog.json")
	opt := testOptions(EngineLitespeed, true, true)
	for name, c := range map[string]struct {
		cfg  *SiteConfig
		want string
	}{"on": {on, "1"}, "off": {off, "0"}, "absent": {absent, "1"}} {
		conf := renderLS(t, c.cfg, opt)["lsws/httpd_config.conf"]
		if !strings.Contains(conf, "ls_enabled              "+c.want) {
			t.Errorf("%s: expected ls_enabled %s", name, c.want)
		}
	}
}

func TestLitespeedCacheGeneration(t *testing.T) {
	cfg := mustLoad(t, "litespeed-wordpress.json")
	for _, bad := range []string{"../x", "a b", "a/b", "x{", strings.Repeat("a", 33), "é"} {
		opt := testOptions(EngineLitespeed, true, true)
		opt.LSCacheGen = bad
		if _, err := Render(cfg, opt); err == nil {
			t.Errorf("generation %q accepted", bad)
		}
	}
	for _, bad := range []string{"relative", "/var/cache/../x", "/var/ca che", "/var/cache/"} {
		opt := testOptions(EngineLitespeed, true, true)
		opt.LSCacheDir = bad
		if _, err := Render(cfg, opt); err == nil {
			t.Errorf("cache dir %q accepted", bad)
		}
	}
	opt := testOptions(EngineLitespeed, true, true)
	opt.LSCacheGen = "1794648310123"
	conf := renderLS(t, cfg, opt)["lsws/httpd_config.conf"]
	mustContain(t, conf, "/var/cache/lscache/1794648310123/pages", "/var/cache/lscache/1794648310123/static")
}

func TestLitespeedValueQuoting(t *testing.T) {
	for _, bad := range []string{"a b", "a{", "}", "#x", "a\nb", `a"b`, "a'b", "a;b", ""} {
		if _, err := lsv(bad); err == nil {
			t.Errorf("lsv accepted %q", bad)
		}
	}
	for _, ok := range []string{"exp:(?i)^/a/.*\\.(php[0-9]?|phar)(/|$)", "/srv/releases/current/a/$1", "uds://run/oblimint/lsphp.sock"} {
		if _, err := lsv(ok); err != nil {
			t.Errorf("lsv refused %q: %v", ok, err)
		}
	}
}

func TestLitespeedBasePathAndPlaceholder(t *testing.T) {
	cfg := mustLoad(t, "litespeed-laravel-blog.json")
	res, err := Render(cfg, testOptions(EngineLitespeed, true, true))
	if err != nil {
		t.Fatal(err)
	}
	var vhost string
	for _, f := range res.Files {
		if f.Name == "lsws/vhost.conf" {
			vhost = f.Content
		}
	}
	mustContain(t, vhost, "docRoot                     /run/oblimint/www/", `context exp:(?i)^/blog/media/(.*\.(?:jpg|png))$`)
	if len(res.Links) != 1 || res.Links[0].Path != "www/blog" || res.Links[0].Target != "/srv/releases/current/public" {
		t.Errorf("unexpected links %+v", res.Links)
	}
	// storage is outside the docroot: never mapped.
	if strings.Contains(vhost, "/storage") {
		t.Errorf("data path outside the docroot mapped:\n%s", vhost)
	}

	ph := renderLS(t, mustLoad(t, "litespeed-wordpress.json"), testOptions(EngineLitespeed, true, false))
	mustContain(t, ph["lsws/vhost.conf"], "RewriteRule ^ - [R=503,L]", "url                     /__oblimint/placeholder.html", "Retry-After: 30", "autoLoadHtaccess        0")
	if _, ok := ph[placeholderMarker]; !ok {
		t.Error("placeholder marker missing")
	}
}

func TestLitespeedWarnings(t *testing.T) {
	cfg := mustLoad(t, "litespeed-wordpress.json")
	custom := "location / { return 418; }"
	cfg.CustomNginx = &custom
	res, err := Render(cfg, testOptions(EngineLitespeed, true, true))
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Warnings) != 1 || !strings.Contains(res.Warnings[0], "OpenLiteSpeed") {
		t.Errorf("expected the customNginx warning, got %v", res.Warnings)
	}
	// An Apache config rendered by the litespeed image (base switch in progress).
	apache := mustLoad(t, "wordpress.json")
	res, err = Render(apache, testOptions(EngineLitespeed, true, true))
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Warnings) == 0 || !strings.Contains(res.Warnings[0], "rendering for litespeed") {
		t.Errorf("expected the engine mismatch warning, got %v", res.Warnings)
	}
}
