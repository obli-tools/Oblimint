package main

import (
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
)

// memFS: an in-memory container filesystem (symlinks cannot be created on
// every test machine — Windows without privilege). Paths are container paths.
type memFS struct {
	t     *testing.T
	nodes map[string]memNode
}

type memNode struct {
	kind   nodeKind
	target string
}

func newMemFS(t *testing.T) *memFS {
	m := &memFS{t: t, nodes: map[string]memNode{"/": {kind: kindDir}}}
	m.mkdir("/srv/releases/12")
	m.mkdir("/srv/data")
	m.link("/srv/releases/current", "12")
	return m
}

func (m *memFS) mkdir(p string) {
	for cur := ""; ; {
		rest := strings.TrimPrefix(p, cur+"/")
		seg, _, _ := strings.Cut(rest, "/")
		cur += "/" + seg
		if _, ok := m.nodes[cur]; !ok {
			m.nodes[cur] = memNode{kind: kindDir}
		}
		if cur == p {
			return
		}
	}
}

func (m *memFS) file(p string) {
	m.mkdir(filepathDir(p))
	m.nodes[p] = memNode{kind: kindOther}
}

func (m *memFS) link(p, target string) {
	m.mkdir(filepathDir(p))
	m.nodes[p] = memNode{kind: kindLink, target: target}
}

func (m *memFS) lstat(c string) (nodeKind, error) {
	n, ok := m.nodes[c]
	if !ok {
		return kindOther, fs.ErrNotExist
	}
	return n.kind, nil
}

func (m *memFS) readlink(c string) (string, error) {
	n, ok := m.nodes[c]
	if !ok || n.kind != kindLink {
		return "", fs.ErrInvalid
	}
	return n.target, nil
}

func (m *memFS) readDir(c string) ([]dirent, error) {
	if n, ok := m.nodes[c]; !ok || n.kind != kindDir {
		return nil, fs.ErrNotExist
	}
	var out []dirent
	for p, n := range m.nodes {
		if p != "/" && filepathDir(p) == c || c == "/" && p != "/" && strings.Count(p, "/") == 1 {
			out = append(out, dirent{name: p[strings.LastIndex(p, "/")+1:], kind: n.kind})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].name < out[j].name })
	return out, nil
}

func (m *memFS) probe() fsProbe { return fsProbe{ops: m} }

func filepathDir(p string) string {
	i := strings.LastIndex(p, "/")
	if i <= 0 {
		return "/"
	}
	return p[:i]
}

func TestRealpathContainerNamespace(t *testing.T) {
	c := newMemFS(t)
	c.mkdir("/srv/data/storage/app/public")
	c.link("/srv/releases/12/storage", "/srv/data/storage")
	c.link("/srv/releases/12/public/storage", "../storage/app/public")
	p := c.probe()

	got, dangling, err := p.realpath("/srv/releases/current/public/storage")
	if err != nil || dangling || got != "/srv/data/storage/app/public" {
		t.Fatalf("realpath = %q %v %v", got, dangling, err)
	}
	// Dangling: resolved lexically from the first missing component.
	got, dangling, err = p.realpath("/srv/releases/current/public/storage/missing/../x")
	if err != nil || !dangling || got != "/srv/data/storage/app/public/x" {
		t.Fatalf("dangling realpath = %q %v %v", got, dangling, err)
	}
	// Loops are an error, never a hang.
	c.link("/srv/releases/12/loop", "loop")
	if _, _, err := p.realpath("/srv/releases/current/loop/a"); err == nil {
		t.Fatal("a symlink loop must fail")
	}
}

func TestDataLinksLaravelStorage(t *testing.T) {
	c := newMemFS(t)
	c.mkdir("/srv/data/storage/app/public")
	c.file("/srv/releases/12/public/index.php")
	c.file("/srv/releases/12/public/.htaccess")
	// Data path link created by materialize (release root, outside the docroot).
	c.link("/srv/releases/12/storage", "/srv/data/storage")
	// The Laravel link kept by the releases module.
	c.link("/srv/releases/12/public/storage", "../storage/app/public")
	// A file link into data: no directory section (guard.php covers PHP).
	c.file("/srv/data/storage/logo.png")
	c.link("/srv/releases/12/public/logo.png", "/srv/data/storage/logo.png")
	// A link into data whose target does not exist yet (PHP may create it).
	c.link("/srv/releases/12/public/later", "/srv/data/later")
	// A directory link INSIDE the release reaching a data link deeper.
	c.mkdir("/srv/releases/12/assets/sub")
	c.link("/srv/releases/12/assets/sub/up", "/srv/data/storage/app")
	c.link("/srv/releases/12/public/assets", "../assets")
	// A link to a release file / outside the release: ignored.
	c.link("/srv/releases/12/public/readme", "../README")
	c.link("/srv/releases/12/public/etc", "/etc")
	// .htaccess links into data: above the docroot and inside it.
	c.file("/srv/data/storage/evil.htaccess")
	c.link("/srv/releases/12/.htaccess", "/srv/data/storage/evil.htaccess")
	c.mkdir("/srv/releases/12/public/admin")
	c.link("/srv/releases/12/public/admin/.htaccess", "../../storage/evil.htaccess")

	got, warnings := c.probe().DataLinks("/srv/releases/current/public")
	if len(warnings) > 0 {
		t.Fatalf("warnings: %v", warnings)
	}
	want := []DataLink{
		{Dir: "", DataRel: "storage/evil.htaccess", HtaccessOnly: true},
		{Dir: "public/admin", DataRel: "storage/evil.htaccess", HtaccessOnly: true},
		{Dir: "public/assets/sub/up", DataRel: "storage/app"},
		{Dir: "public/later", DataRel: "later"},
		{Dir: "public/storage", DataRel: "storage/app/public"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("DataLinks =\n%+v\nwant\n%+v", got, want)
	}
}

func TestDataLinksDocrootInsideData(t *testing.T) {
	c := newMemFS(t)
	c.mkdir("/srv/data/web")
	c.link("/srv/releases/12/public", "/srv/data/web")
	got, _ := c.probe().DataLinks("/srv/releases/current/public")
	want := []DataLink{{Dir: "public", DataRel: "web"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("DataLinks = %+v, want %+v", got, want)
	}
}

func TestDataLinksNoDocroot(t *testing.T) {
	c := newMemFS(t)
	got, warnings := c.probe().DataLinks("/srv/releases/current/public")
	if len(got) != 0 || len(warnings) != 0 {
		t.Fatalf("missing docroot must give nothing: %v %v", got, warnings)
	}
}

func TestDataLinksCycleSafe(t *testing.T) {
	c := newMemFS(t)
	c.mkdir("/srv/releases/12/a")
	c.link("/srv/releases/12/a/self", "..")
	c.link("/srv/releases/12/a/data", "/srv/data")
	got, warnings := c.probe().DataLinks("/srv/releases/current")
	if len(warnings) > 0 {
		t.Fatalf("warnings: %v", warnings)
	}
	want := []DataLink{{Dir: "a/data", DataRel: ""}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("DataLinks = %+v, want %+v", got, want)
	}
}

// ── Render with discovered links ────────────────────────────────────────────

func linkOptions(links []DataLink, warnings ...string) Options {
	opt := testOptions(EngineApache, true, true)
	opt.DataLinks = func(string) ([]DataLink, []string) { return links, warnings }
	return opt
}

func directoryBlock(t *testing.T, conf, open string) string {
	t.Helper()
	i := strings.Index(conf, open)
	if i < 0 {
		t.Fatalf("missing %s in:\n%s", open, conf)
	}
	j := strings.Index(conf[i:], "</Directory>")
	return conf[i : i+j]
}

func TestApacheDataLinkSections(t *testing.T) {
	cfg := mustLoad(t, "laravel-blog.json")
	cfg.Base = "apache-php8.4"
	cfg.CustomNginx = nil
	links := []DataLink{
		{Dir: "public/storage", DataRel: "storage/app/public"},
		{Dir: "public/pics", DataRel: "public/media/2024"},
		{Dir: "public/all", DataRel: ""},
		{Dir: "public/media", DataRel: "public/media"}, // data path's own link: covered
		{Dir: "public/admin", DataRel: "storage/x.htaccess", HtaccessOnly: true},
		{Dir: `public/we"ird *[dir]`, DataRel: "storage/w"},
	}
	res, err := Render(cfg, linkOptions(links, "walk warning"))
	if err != nil {
		t.Fatal(err)
	}
	var conf string
	for _, f := range res.Files {
		if f.Name == "httpd.conf" {
			conf = f.Content
		}
	}
	if !reflect.DeepEqual(res.Warnings, []string{"walk warning"}) {
		t.Errorf("warnings = %v", res.Warnings)
	}

	b := directoryBlock(t, conf, `<Directory "/srv/releases/current/public/storage">`)
	for _, s := range []string{"AllowOverride None", "SetHandler None", `(?i)\.(php[0-9]?|phar|phtml|pht|phps)$`} {
		if !strings.Contains(b, s) {
			t.Errorf("storage link block lacks %q:\n%s", s, b)
		}
	}
	if strings.Contains(b, "Require all denied\n    <FilesMatch \"(?i)\\.(jpg") {
		t.Errorf("persistent target must not be typed:\n%s", b)
	}
	// Target inside a typed path: its whitelist applies.
	b = directoryBlock(t, conf, `<Directory "/srv/releases/current/public/pics">`)
	if !strings.Contains(b, "Require all denied") || !strings.Contains(b, `<FilesMatch "(?i)\.(jpg|png)$">`) {
		t.Errorf("typed target must keep its whitelist:\n%s", b)
	}
	// Target containing a typed path: everything denied.
	b = directoryBlock(t, conf, `<Directory "/srv/releases/current/public/all">`)
	if !strings.Contains(b, "Require all denied") || strings.Contains(b, "Require all granted") {
		t.Errorf("link to /srv/data must deny everything:\n%s", b)
	}
	// .htaccess link: only the overrides are disabled.
	b = directoryBlock(t, conf, `<Directory "/srv/releases/current/public/admin">`)
	if !strings.Contains(b, "AllowOverride None") || strings.Contains(b, "SetHandler None") {
		t.Errorf(".htaccess-only block:\n%s", b)
	}
	// Unsafe bytes become single-byte wildcards, never reach the config raw.
	directoryBlock(t, conf, `<Directory "/srv/releases/current/public/we?ird???dir?">`)
	if strings.Contains(conf, `we"ird`) || strings.Contains(conf, "*[dir]") {
		t.Error("raw unsafe name leaked into httpd.conf")
	}
	// The data path's own link is not duplicated.
	if n := strings.Count(conf, `<Directory "/srv/releases/current/public/media">`); n != 1 {
		t.Errorf("public/media sections = %d, want 1", n)
	}
	// php-fpm never receives a script reached through a data link.
	mustContain(t, conf, `public/storage|public/pics|public/all|public/we.ird...dir.)(?:/|$))#">`)
}

func TestDataLinksIgnoredOutsideApache(t *testing.T) {
	cfg := mustLoad(t, "laravel-blog.json")
	called := false
	opt := testOptions(EngineNginx, true, true)
	opt.DataLinks = func(string) ([]DataLink, []string) { called = true; return nil, nil }
	if _, err := Render(cfg, opt); err != nil {
		t.Fatal(err)
	}
	cfg.Base = "apache-php8.4"
	opt = linkOptions([]DataLink{{Dir: "public/storage", DataRel: "storage"}})
	opt.DocrootExists = func(string) bool { return false }
	opt.DataLinks = func(string) ([]DataLink, []string) { called = true; return nil, nil }
	if _, err := Render(cfg, opt); err != nil {
		t.Fatal(err)
	}
	if called {
		t.Error("the walk must only run for a served Apache site")
	}
}

func TestGlobPathAndBytesRegex(t *testing.T) {
	if g := globPath("/srv/releases/current/a b/é"); g != "/srv/releases/current/a?b/??" {
		t.Errorf("globPath = %q", g)
	}
	if r := bytesRegex("a.b+c d"); r != `a\.b\+c.d` {
		t.Errorf("bytesRegex = %q", r)
	}
	if _, err := ag(`/x"y`); err == nil {
		t.Error("ag must refuse a quote")
	}
}

// The same walk on the real filesystem (Linux CI; skipped without symlinks).
func TestDataLinksRealFS(t *testing.T) {
	root := t.TempDir()
	h := func(p string) string { return filepath.Join(root, filepath.FromSlash(p)) }
	for _, d := range []string{"/srv/releases/12/public", "/srv/data/storage/app/public"} {
		if err := os.MkdirAll(h(d), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	for l, target := range map[string]string{
		"/srv/releases/current":           "12",
		"/srv/releases/12/storage":        "/srv/data/storage",
		"/srv/releases/12/public/storage": "../storage/app/public",
	} {
		if err := os.Symlink(filepath.FromSlash(target), h(l)); err != nil {
			t.Skipf("symlinks unavailable here: %v", err)
		}
	}
	got, warnings := newFSProbe(root).DataLinks("/srv/releases/current/public")
	want := []DataLink{{Dir: "public/storage", DataRel: "storage/app/public"}}
	if len(warnings) > 0 || !reflect.DeepEqual(got, want) {
		t.Fatalf("DataLinks = %+v %v, want %+v", got, warnings, want)
	}
}
