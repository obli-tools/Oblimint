package main

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

func parse(t *testing.T, s string) []AccessRule {
	t.Helper()
	return ParseHtaccessAccess([]byte(s))
}

func TestHtaccessParseReproduced(t *testing.T) {
	cases := map[string]struct {
		in        string
		action    AccessAction
		directive string
		files     *FilePattern
	}{
		"require denied":      {"Require all denied\n", AccessDeny, "Require all denied", nil},
		"deny from all":       {"Deny from all\n", AccessDeny, "Deny from all", nil},
		"order + deny":        {"Order Deny,Allow\nDeny from all\n", AccessDeny, "Deny from all", nil},
		"order allow,deny":    {"Order allow,deny\n", AccessDeny, "Order allow,deny", nil},
		"ifmodule both forms": {"<IfModule mod_authz_core.c>\n  Require all denied\n</IfModule>\n<IfModule !mod_authz_core.c>\n  Order allow,deny\n  Deny from all\n</IfModule>\n", AccessDeny, "Require all denied", nil},
		"files xmlrpc":        {"# BEGIN\n<Files xmlrpc.php>\norder deny,allow\ndeny from all\n</Files>\n", AccessDeny, "Deny from all", &FilePattern{FilesName, "xmlrpc.php"}},
		"files quoted":        {"<Files \"wp-config.php\">\nRequire all denied\n</Files>", AccessDeny, "Require all denied", &FilePattern{FilesName, "wp-config.php"}},
		"files glob":          {"<Files *.log>\nDeny from all\n</Files>", AccessDeny, "Deny from all", &FilePattern{FilesGlob, "*.log"}},
		"filesmatch":          {"<FilesMatch \"\\.(ini|log|sh)$\">\nRequire all denied\n</FilesMatch>", AccessDeny, "Require all denied", &FilePattern{FilesRegex, `\.(ini|log|sh)$`}},
		"files tilde":         {"<Files ~ \"^\\.ht\">\nDeny from all\n</Files>", AccessDeny, "Deny from all", &FilePattern{FilesRegex, `^\.ht`}},
	}
	for name, c := range cases {
		rules := parse(t, c.in)
		if len(rules) != 1 {
			t.Errorf("%s: %d rules %+v", name, len(rules), rules)
			continue
		}
		r := rules[0]
		if r.Action != c.action || r.Directive != c.directive {
			t.Errorf("%s: got %s %q", name, r.Action, r.Directive)
		}
		if (r.Files == nil) != (c.files == nil) || (r.Files != nil && *r.Files != *c.files) {
			t.Errorf("%s: files %+v, want %+v", name, r.Files, c.files)
		}
	}
}

func TestHtaccessParseClosedAndAllowed(t *testing.T) {
	closed := map[string]string{
		"basic auth":         "AuthType Basic\nAuthName \"Admin\"\nAuthUserFile /home/x/.htpasswd\nRequire valid-user\n",
		"require valid-user": "Require valid-user\n",
		"require ip":         "Require ip 203.0.113.0/24\n",
		"allow from ip":      "Order deny,allow\nDeny from all\nAllow from 203.0.113.9\n",
		"limit":              "<Limit GET POST>\nDeny from all\n</Limit>\n",
		"if":                 "<If \"%{REMOTE_ADDR} == '1.2.3.4'\">\nRequire all denied\n</If>\n",
		"require any":        "<RequireAny>\nRequire ip 1.2.3.4\nRequire valid-user\n</RequireAny>\n",
		"unclosed files":     "<Files secret.txt>\nDeny from all\n",
		"satisfy any":        "Satisfy any\nDeny from all\n",
		"mutual failure":     "Order mutual-failure\n",
	}
	for name, in := range closed {
		rules := parse(t, in)
		if len(rules) == 0 || rules[0].Action != AccessClosed {
			t.Errorf("%s: expected closed, got %+v", name, rules)
		}
	}
	// Auth in a <Files> section closes those files only.
	r := parse(t, "<Files admin.php>\nAuthType Basic\nRequire valid-user\n</Files>\n")
	if len(r) != 1 || r[0].Action != AccessClosed || r[0].Files == nil || r[0].Files.Pattern != "admin.php" {
		t.Errorf("auth in Files: %+v", r)
	}
	for name, in := range map[string]string{
		"rewrite only":     "RewriteEngine On\nRewriteRule . /index.php [L]\n",
		"require granted":  "Require all granted\n",
		"allow all":        "Order allow,deny\nAllow from all\n",
		"deny,allow alone": "Order deny,allow\n",
		"limit granted":    "<Limit GET>\nRequire all granted\n</Limit>\n",
		"options":          "Options -Indexes\nphp_value memory_limit 64M\n",
		"comment":          "# Deny from all\n",
	} {
		if rules := parse(t, in); len(rules) != 0 {
			t.Errorf("%s: expected nothing, got %+v", name, rules)
		}
	}
	// WordPress-like root: rewrites + xmlrpc / wp-config refusals.
	wp := "# BEGIN WordPress\n<IfModule mod_rewrite.c>\nRewriteEngine On\nRewriteRule . /index.php [L]\n</IfModule>\n# END WordPress\n" +
		"<Files xmlrpc.php>\nOrder Deny,Allow\nDeny from all\n</Files>\n<Files wp-config.php>\nOrder allow,deny\nDeny from all\n</Files>\n"
	rules := parse(t, wp)
	if len(rules) != 2 || rules[0].Files.Pattern != "xmlrpc.php" || rules[1].Files.Pattern != "wp-config.php" {
		t.Errorf("wordpress: %+v", rules)
	}
}

func TestFileRegexSafe(t *testing.T) {
	for re, want := range map[string]bool{
		`\.(ini|log|sh)$`:  true,
		`^wp-config\.php$`: true,
		`^(a|b)\.txt$`:     true,
		`^a|b`:             false, // top-level alternation behind ^
		`x^y`:              false,
		`[^a]\.log`:        true,
		`\.(log){2}`:       false, // braces never reach the configuration
		`a b`:              false,
		`(?<=x)y`:          false, // not RE2: unknown for the checker
	} {
		if got := fileRegexSafe(re); got != want {
			t.Errorf("%q: %v, want %v", re, got, want)
		}
	}
}

// matchContexts: the URIs a rendered access context refuses (Go regexp, look-ahead emulated by the test).
func accessMatch(t *testing.T, ctx []lsContext, uri string) bool {
	t.Helper()
	for _, c := range ctx {
		re := strings.TrimPrefix(c.URI, "exp:")
		switch {
		case re == "(?:^/(?!__oblimint/))":
			if strings.HasPrefix(uri, "/") && !strings.HasPrefix(uri, "/__oblimint/") {
				return true
			}
			continue
		case strings.Contains(re, "(?="):
			// (?:^D(?:.*/)?(?=X)[^/]*$): split on the look-ahead.
			i := strings.Index(re, "(?=")
			head := re[:i]
			j := strings.LastIndex(re, ")[^/]*$)")
			look := re[i+3 : j]
			if m := regexp.MustCompile(head + ")").FindString(uri); m == "" {
				continue
			}
			base := uri[strings.LastIndex(uri, "/")+1:]
			if regexp.MustCompile("^" + look).MatchString(base) {
				prefix := regexp.MustCompile(head + "[^/]*$)")
				if prefix.MatchString(uri) {
					return true
				}
			}
			continue
		}
		if regexp.MustCompile(re).MatchString(uri) {
			return true
		}
	}
	return false
}

func TestHtaccessContexts(t *testing.T) {
	cfg := mustLoad(t, "litespeed-wordpress.json")
	rules := []AccessRule{
		{Dir: "private", Action: AccessDeny, Directive: "Deny from all"},
		{Dir: "", Files: &FilePattern{FilesName, "xmlrpc.php"}, Action: AccessDeny},
		{Dir: "", Files: &FilePattern{FilesName, "wp-config.php"}, Action: AccessDeny},
		{Dir: "admin", Action: AccessClosed, Directive: "AuthType Basic"},
		{Dir: "logs", Files: &FilePattern{FilesGlob, "*.log"}, Action: AccessDeny},
		{Dir: "conf", Files: &FilePattern{FilesRegex, `\.(ini|bak)$`}, Action: AccessDeny},
		{Dir: "x", Files: &FilePattern{FilesRegex, `^secret`}, Action: AccessDeny},
		{Dir: "y", Paths: []string{"y/a b.txt"}, Files: &FilePattern{FilesRegex, `a\sb`}, Action: AccessDeny},
	}
	ctx := lsAccessContexts(cfg, rules, nil)
	for _, c := range ctx {
		if !strings.HasPrefix(c.URI, "exp:(?:") {
			t.Errorf("access context must sort first: %s", c.URI)
		}
	}
	for uri, want := range map[string]bool{
		"/private":             true,
		"/private/":            true,
		"/private/a/b.php":     true,
		"/privateer/x":         false,
		"/xmlrpc.php":          true,
		"/wp-admin/xmlrpc.php": true,
		"/wp-config.php":       true,
		"/wp-config.php.bak":   false,
		"/admin/index.php":     true,
		"/logs/2026/app.log":   true,
		"/logs/app.txt":        false,
		"/conf/db.ini":         true,
		"/conf/sub/old.bak":    true,
		"/conf/readme.md":      false,
		"/x/secret.txt":        true,
		"/x/my-secret.txt":     false,
		"/y/a b.txt":           true,
		"/index.php":           false,
		"/hello-world/":        false,
		"/__oblimint/ping":     false,
	} {
		if got := accessMatch(t, ctx, uri); got != want {
			t.Errorf("%s: refused=%v, want %v", uri, got, want)
		}
	}
	// A refused site root never hides the built-in pages.
	root := lsAccessContexts(cfg, []AccessRule{{Dir: "", Action: AccessDeny}}, nil)
	if accessMatch(t, root, "/__oblimint/ping") || !accessMatch(t, root, "/index.php") {
		t.Errorf("root refusal: %+v", root)
	}
	// Outside the docroot: unreachable, nothing emitted; ancestor of the docroot: the whole site.
	lara := mustLoad(t, "litespeed-laravel-blog.json") // docroot public, basePath /blog/
	if c := lsAccessContexts(lara, []AccessRule{{Dir: "storage", Action: AccessDeny}}, nil); len(c) != 0 {
		t.Errorf("outside the docroot: %+v", c)
	}
	c := lsAccessContexts(lara, []AccessRule{{Dir: "", Action: AccessClosed}, {Dir: "public/admin", Action: AccessDeny}}, nil)
	if len(c) != 2 || c[0].URI != "exp:(?:^/blog(?:/|$))" || c[1].URI != `exp:(?:^/blog/admin(?:/|$))` {
		t.Errorf("basePath: %+v", c)
	}
}

func TestHtaccessWalkAndRender(t *testing.T) {
	root := t.TempDir()
	rel := filepath.Join(root, "srv", "releases", "1")
	mk := func(p, content string) {
		full := filepath.Join(rel, filepath.FromSlash(p))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	mk("index.php", "<?php")
	mk(".htaccess", "RewriteEngine On\n<Files xmlrpc.php>\nDeny from all\n</Files>\n")
	mk("private/.htaccess", "Require all denied\n")
	mk("private/data.txt", "x")
	mk("admin/.htaccess", "AuthType Basic\nAuthUserFile /x\nRequire valid-user\n")
	mk("logs/.htaccess", "<FilesMatch \"\\.log{1,2}$\">\nDeny from all\n</FilesMatch>\n")
	mk("logs/a.log", "x")
	mk("logs/b.txt", "x")
	if err := os.Symlink("1", filepath.Join(root, "srv", "releases", "current")); err != nil {
		t.Skipf("no symlinks here: %v", err)
	}
	if err := os.Symlink("private", filepath.Join(rel, "alias")); err != nil {
		t.Skipf("no symlinks here: %v", err)
	}
	rules, warnings := newFSProbe(root).HtaccessAccess("/srv/releases/current")
	got := map[string]AccessAction{}
	for _, r := range rules {
		k := r.Dir
		if r.Files != nil {
			k += ":" + r.Files.Pattern
		}
		if len(r.Paths) > 0 {
			k += "=" + strings.Join(r.Paths, ",")
		}
		got[k] = r.Action
	}
	want := map[string]AccessAction{
		":xmlrpc.php":                  AccessDeny,
		"private":                      AccessDeny,
		"alias":                        AccessDeny,
		"admin":                        AccessClosed,
		"logs:\\.log{1,2}$=logs/a.log": AccessDeny,
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s: %q (all: %v)", k, got[k], got)
		}
	}
	if len(warnings) == 0 || !strings.Contains(strings.Join(warnings, "\n"), "AuthType Basic") {
		t.Errorf("warnings: %v", warnings)
	}
	// Rendered into the vhost.
	cfg := mustLoad(t, "litespeed-wordpress.json")
	opt := testOptions(EngineLitespeed, true, true)
	opt.HtaccessAccess = func(string) ([]AccessRule, []string) { return rules, warnings }
	vhost := renderLS(t, cfg, opt)["lsws/vhost.conf"]
	for _, s := range []string{
		"context exp:(?:^/private(?:/|$)) {",
		"context exp:(?:^/alias(?:/|$)) {",
		"context exp:(?:^/admin(?:/|$)) {",
		`context exp:(?:^/logs/a\.log$) {`,
		`context exp:(?:^/(?:.*/)?(?=xmlrpc\.php$)[^/]*$) {`,
	} {
		if !strings.Contains(vhost, s) {
			t.Errorf("missing %q in vhost:\n%s", s, vhost)
		}
	}
}

func TestHtaccessGrantsInsideRefusedFolder(t *testing.T) {
	akismet := "<IfModule !mod_authz_core.c>\n\tOrder Deny,Allow\n\tDeny from all\n</IfModule>\n<IfModule mod_authz_core.c>\n\tRequire all denied\n</IfModule>\n" +
		`<FilesMatch "^(form\.js|akismet(-frontend|-admin)?\.js|akismet(-admin)?(-rtl)?\.css)$">` + "\n\t<IfModule !mod_authz_core.c>\n\t\tAllow from all\n\t</IfModule>\n" +
		"\t<IfModule mod_authz_core.c>\n\t\tRequire all granted\n\t</IfModule>\n</FilesMatch>\n"
	rules := parse(t, akismet)
	if len(rules) != 2 || rules[0].Action != AccessDeny || rules[0].Files != nil || rules[1].Action != AccessAllow || rules[1].Files == nil {
		t.Fatalf("akismet: %+v", rules)
	}
	for i := range rules {
		rules[i].Dir = "wp-content/plugins/akismet"
	}
	// A refused sub-folder, a <Files> refusal elsewhere, a data path below.
	rules = append(rules,
		AccessRule{Dir: "wp-content/plugins/akismet/views", Action: AccessDeny},
		AccessRule{Dir: "", Files: &FilePattern{FilesName, "xmlrpc.php"}, Action: AccessDeny},
	)
	cfg := mustLoad(t, "litespeed-wordpress.json")
	ctx := lsAccessContexts(cfg, rules, []string{"wp-content/plugins/akismet/cache"})
	var grant *lsContext
	for i := range ctx {
		if ctx[i].Allow {
			grant = &ctx[i]
		}
	}
	if grant == nil {
		t.Fatalf("no grant context: %+v", ctx)
	}
	for _, s := range []string{
		`exp:(?:(?:^/wp-content/plugins/akismet/(?!(?:cache|views)(?:/|$))(`, // sub-folder refused / data path: never re-allowed
		`(?!(?:[^/]*/)*\.)`, // hidden paths
		`(?=(form\.js|akismet(-frontend|-admin)?\.js|akismet(-admin)?(-rtl)?\.css)$)`,
		`(?!xmlrpc\.php$)`, // any <Files> refusal wins
		`(?!(?i:[^/]*\.(?:php[0-9]|phar|phtml|pht|phps)$))`,
	} {
		if !strings.Contains(grant.URI, s) {
			t.Errorf("grant URI lacks %q: %s", s, grant.URI)
		}
	}
	if grant.Location != "/srv/releases/current/wp-content/plugins/akismet/$1" || !grant.NoRewrite {
		t.Errorf("grant: %+v", grant)
	}
	if !(grant.URI < "exp:(?:^/wp") {
		t.Errorf("a grant must sort before the refusals: %s", grant.URI)
	}
	// Outside a refused folder a grant writes nothing.
	alone := lsAccessContexts(cfg, []AccessRule{{Dir: "x", Files: &FilePattern{FilesName, "a.js"}, Action: AccessAllow}}, nil)
	if len(alone) != 0 {
		t.Errorf("grant alone: %+v", alone)
	}
	// Grant syntax checked by the regexp engine minus the look-arounds Go lacks.
	if _, err := regexp.Compile(strings.NewReplacer("(?!", "(", "(?=", "(").Replace(strings.TrimPrefix(grant.URI, "exp:"))); err != nil {
		t.Errorf("grant regex: %v", err)
	}
}
