package main

// Rendering: validated SiteConfig → web server config + php-fpm pool.
//
// Pure (no I/O except the injectable docroot existence probe): Render returns
// the files and symlinks to create; writing them is the CLI's job (write.go).
// Templates use text/template; every value that reaches them is either a
// constant, an integer, or a string re-checked by one of the quoting helpers
// below, which FAIL the render (instead of escaping) when a character outside
// their whitelist shows up — validation already refused such input, so a
// failure here means a bug, never a silent injection.

import (
	"bytes"
	"embed"
	"fmt"
	"os"
	"path"
	"regexp"
	"sort"
	"strings"
	"text/template"
)

//go:embed templates/*.tmpl
var templateFS embed.FS

// Options describe the image the renderer runs in.
type Options struct {
	Engine Engine
	// Out is the CONTAINER directory the files are rendered for (pid files,
	// custom.conf and the basePath tree are referenced from it).
	Out    string
	PHPFPM bool
	// ConfigFile is only echoed in the generated headers.
	ConfigFile string
	// DocrootExists probes the docroot (placeholder mode when false).
	DocrootExists func(docroot string) bool
	// DataLinks discovers the release symlinks that reach /srv/data under the
	// docroot (datalinks.go; Apache only — nil = none). Warnings are passed on.
	DataLinks func(docroot string) ([]DataLink, []string)
	// Image-specific paths (defaults: Alpine packages / official nginx image).
	ApacheModulesDir string
	ApacheMimeTypes  string
	NginxMimeTypes   string
}

// OutFile is a file to write under Options.Out (Name is relative, no '/').
type OutFile struct {
	Name    string
	Content string
}

// OutLink is a symlink to create under Options.Out/www (nginx basePath tree).
type OutLink struct {
	// Path relative to Options.Out (e.g. "www/blog").
	Path   string
	Target string
}

// Output of a render.
type Output struct {
	Files       []OutFile
	Links       []OutLink
	Placeholder bool
	// CustomRejected: why the custom nginx rules were dropped ("" otherwise).
	CustomRejected string
	Warnings       []string
}

// Marker file written in placeholder mode (removed otherwise).
const placeholderMarker = "placeholder"

type apacheModule struct{ Name, File string }

// Modules loaded by the Apache bases (Alpine apache2 + apache2-proxy). The
// auth / access_compat / version / expires / headers modules are there for
// the .htaccess files CMSs ship (CWP compatibility).
var apacheModules = []apacheModule{
	{"mpm_event_module", "mod_mpm_event.so"},
	{"unixd_module", "mod_unixd.so"},
	{"authz_core_module", "mod_authz_core.so"},
	{"authz_host_module", "mod_authz_host.so"},
	{"authz_user_module", "mod_authz_user.so"},
	{"authz_groupfile_module", "mod_authz_groupfile.so"},
	{"authn_core_module", "mod_authn_core.so"},
	{"authn_file_module", "mod_authn_file.so"},
	{"auth_basic_module", "mod_auth_basic.so"},
	{"access_compat_module", "mod_access_compat.so"},
	{"reqtimeout_module", "mod_reqtimeout.so"},
	{"filter_module", "mod_filter.so"},
	{"deflate_module", "mod_deflate.so"},
	{"mime_module", "mod_mime.so"},
	{"log_config_module", "mod_log_config.so"},
	{"env_module", "mod_env.so"},
	{"expires_module", "mod_expires.so"},
	{"headers_module", "mod_headers.so"},
	{"setenvif_module", "mod_setenvif.so"},
	{"version_module", "mod_version.so"},
	{"remoteip_module", "mod_remoteip.so"},
	{"proxy_module", "mod_proxy.so"},
	{"proxy_fcgi_module", "mod_proxy_fcgi.so"},
	{"dir_module", "mod_dir.so"},
	{"autoindex_module", "mod_autoindex.so"},
	{"alias_module", "mod_alias.so"},
	{"rewrite_module", "mod_rewrite.so"},
	// Built into the apache-php images (php/mod_oblimint_https): X-Forwarded-Proto https → %{HTTPS} on.
	{"oblimint_https_module", "mod_oblimint_https.so"},
}

type dataPathView struct {
	Path       string
	Policy     DataPolicy
	Typed      bool
	Extensions []string
	// CurrentDir: /srv/releases/current/<path> (Apache <Directory>).
	CurrentDir string
	// ReleaseRegex: /srv/releases/[^/]+/<quoted path> (any release).
	ReleaseRegex string
	// URLPrefix: <basePath><path relative to docroot>/ ("" = outside the docroot).
	URLPrefix string
}

// dataLinkView: a release directory reaching /srv/data through a symlink
// (Apache <Directory>, wildcard-quoted: see globPath).
type dataLinkView struct {
	// CurrentDir: /srv/releases/current/<dir>, unsafe bytes as "?".
	CurrentDir string
	Comment    string
	// Data: the directory content is data (else only its .htaccess is).
	Data       bool
	Typed      bool
	Extensions []string
}

type templateData struct {
	ConfigFile string
	SiteID     int64
	Role       string
	Base       string
	Out        string
	TempDir    string
	ShareDir   string
	DataRoot   string
	GuardFile  string
	// ExecDirs: oblimint.exec_dirs of the pool (see execdirs.go).
	ExecDirs  string
	FpmSocket string

	SessionsDir  string
	ReleasesRoot string

	Placeholder bool
	PHP         bool
	// LegacyPHP: the image runs PHP 5 (PHP_VERSION of the official image):
	// php-fpm 5 refuses the pool directives added since (decorate_workers_output, 7.3).
	LegacyPHP bool

	Docroot       string
	BasePath      string
	BasePathAlias string
	NginxRoot     string

	DataPaths       []dataPathView
	DataLinks       []dataLinkView
	PHPExcludeRegex string
	PHPSettings     PhpSettings
	Timeout         int
	ClientMaxBodyMb int

	CustomIncluded         bool
	AppLocationOverridden  bool
	RootLocationOverridden bool

	ApacheModules []apacheModule
	ModulesDir    string
	MimeTypes     string
}

var (
	// Characters allowed in a value written inside "…" (Apache) or bare (nginx).
	safeValueRE = regexp.MustCompile(`^[A-Za-z0-9._@+/:=-]+$`)
	// Apache wildcard paths (globPath): the same plus "?".
	safeGlobRE = regexp.MustCompile(`^[A-Za-z0-9._@+/:=?-]+$`)
	// Output of regexp.QuoteMeta over validated path characters.
	safeRegexRE = regexp.MustCompile(`^[A-Za-z0-9._@+/\\\-\[\]^(?:)|$]+$`)
)

// ag quotes an Apache <Directory> wildcard path built by globPath ("?" allowed).
func ag(v string) (string, error) {
	if !safeGlobRE.MatchString(v) {
		return "", fmt.Errorf("refusing unsafe Apache wildcard path %q", v)
	}
	return `"` + v + `"`, nil
}

// aq quotes a value for Apache: "value". Refuses anything outside the whitelist.
func aq(v string) (string, error) {
	if !safeValueRE.MatchString(v) {
		return "", fmt.Errorf("refusing unsafe Apache value %q", v)
	}
	return `"` + v + `"`, nil
}

// ns checks a bare nginx value (no quoting needed for the whitelist).
func ns(v string) (string, error) {
	if !safeValueRE.MatchString(v) {
		return "", fmt.Errorf("refusing unsafe nginx value %q", v)
	}
	return v, nil
}

// joinExt joins validated extensions (re-checked: ^[a-z0-9]{1,10}$).
func joinExt(exts []string, sep string) (string, error) {
	for _, e := range exts {
		if !extensionRE.MatchString(e) {
			return "", fmt.Errorf("refusing unsafe extension %q", e)
		}
	}
	return strings.Join(exts, sep), nil
}

func joinPath(dir, name string) string { return path.Join(dir, name) }

// pathRegex quotes a validated relative path for a PCRE (DirectoryMatch, ap_expr).
func pathRegex(rel string) (string, error) {
	q := regexp.QuoteMeta(rel)
	if !safeRegexRE.MatchString(q) || strings.ContainsAny(q, "\"#\n") {
		return "", fmt.Errorf("refusing unsafe path regex %q", q)
	}
	return q, nil
}

var templates = template.Must(template.New("siteconf").
	Option("missingkey=error").
	Funcs(template.FuncMap{"aq": aq, "ag": ag, "ns": ns, "joinExt": joinExt, "join": joinPath}).
	ParseFS(templateFS, "templates/*.tmpl"))

// Render produces the configuration of one site container.
func Render(cfg *SiteConfig, opt Options) (*Output, error) {
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	switch opt.Engine {
	case EngineApache, EngineNginx, EngineStatic:
	default:
		return nil, fmt.Errorf("unknown engine %q", opt.Engine)
	}
	if opt.Engine == EngineStatic && opt.PHPFPM {
		return nil, fmt.Errorf("the static engine has no php-fpm")
	}
	if !strings.HasPrefix(opt.Out, "/") || !safeValueRE.MatchString(opt.Out) || path.Clean(opt.Out) != opt.Out {
		return nil, fmt.Errorf("invalid output directory %q (absolute, clean path expected)", opt.Out)
	}
	out := &Output{}
	if be := cfg.EngineOfBase(); be != opt.Engine {
		// The panel may write the next base's config just before recreating the
		// container: render for THIS image, never refuse to serve.
		out.Warnings = append(out.Warnings, fmt.Sprintf("base %s expects the %s engine but this image runs %s: rendering for %s", cfg.Base, be, opt.Engine, opt.Engine))
	}

	exists := opt.DocrootExists
	if exists == nil {
		exists = func(string) bool { return true }
	}
	out.Placeholder = !exists(cfg.Docroot)

	d := templateData{
		ConfigFile:      opt.ConfigFile,
		SiteID:          cfg.SiteID,
		Role:            cfg.Role,
		Base:            cfg.Base,
		Out:             opt.Out,
		TempDir:         nginxTempDir,
		ShareDir:        shareDir,
		DataRoot:        dataRoot,
		GuardFile:       guardFile,
		FpmSocket:       phpFpmSocket,
		SessionsDir:     sessionsDir,
		ReleasesRoot:    releasesRoot,
		Placeholder:     out.Placeholder,
		PHP:             opt.PHPFPM,
		LegacyPHP:       strings.HasPrefix(os.Getenv("PHP_VERSION"), "5."),
		Docroot:         cfg.Docroot,
		BasePath:        cfg.BasePath,
		BasePathAlias:   strings.TrimSuffix(cfg.BasePath, "/"),
		NginxRoot:       cfg.Docroot,
		PHPSettings:     cfg.PHP,
		Timeout:         cfg.PHP.MaxExecutionTime + 30,
		ClientMaxBodyMb: max(cfg.PHP.PostMaxSizeMb, cfg.PHP.UploadMaxFilesizeMb),
		ApacheModules:   apacheModules,
		ModulesDir:      opt.ApacheModulesDir,
		MimeTypes:       opt.NginxMimeTypes,
	}
	if opt.Engine == EngineApache {
		d.MimeTypes = opt.ApacheMimeTypes
	}
	if opt.ConfigFile == "" {
		d.ConfigFile = "the site config"
	}

	views, err := dataPathViews(cfg)
	if err != nil {
		return nil, err
	}
	d.DataPaths = views
	var linkRegexes []string
	if opt.Engine == EngineApache && !out.Placeholder && opt.DataLinks != nil {
		found, warnings := opt.DataLinks(cfg.Docroot)
		out.Warnings = append(out.Warnings, warnings...)
		d.DataLinks, linkRegexes = dataLinkViews(cfg, found)
	}
	if d.ExecDirs, err = execDirs(cfg); err != nil {
		return nil, err
	}
	if d.PHPExcludeRegex, err = phpExcludeRegex(views, linkRegexes); err != nil {
		return nil, err
	}

	// nginx sub-site (basePath ≠ '/'): root = <out>/www, where <out>/www/<basePath>
	// is a symlink to the docroot, so URL /blog/x maps to <docroot>/x with a
	// plain `root` (no `alias` + try_files pitfalls).
	if opt.Engine != EngineApache && cfg.BasePath != "/" && !out.Placeholder {
		d.NginxRoot = path.Join(opt.Out, "www")
		out.Links = append(out.Links, OutLink{Path: path.Join("www", strings.Trim(cfg.BasePath, "/")), Target: cfg.Docroot})
	}

	// Custom nginx rules (nginx engines only).
	custom := CheckCustomNginx(cfg.CustomNginx)
	if opt.Engine == EngineApache {
		if custom.Content != "" || custom.Rejected != "" {
			out.Warnings = append(out.Warnings, "customNginx ignored: this base runs Apache (use .htaccess)")
		}
		custom = CustomRules{}
	}
	if custom.Rejected != "" {
		out.CustomRejected = custom.Rejected
		out.Warnings = append(out.Warnings, "custom nginx rules disabled: "+custom.Rejected)
	}
	if opt.Engine != EngineApache {
		d.CustomIncluded = custom.Content != "" && !out.Placeholder
		d.AppLocationOverridden = d.CustomIncluded && custom.DefinesLocation(cfg.BasePath)
		d.RootLocationOverridden = d.CustomIncluded && custom.DefinesLocation("/")
		out.Files = append(out.Files, OutFile{Name: "custom.conf", Content: customFileContent(custom)})
	}

	// Main web server config.
	main := map[Engine][2]string{
		EngineApache: {"httpd.conf.tmpl", "httpd.conf"},
		EngineNginx:  {"nginx.conf.tmpl", "nginx.conf"},
		EngineStatic: {"nginx.conf.tmpl", "nginx.conf"},
	}[opt.Engine]
	content, err := execute(main[0], d)
	if err != nil {
		return nil, err
	}
	out.Files = append(out.Files, OutFile{Name: main[1], Content: content})

	if opt.PHPFPM {
		pool, err := execute("php-fpm.conf.tmpl", d)
		if err != nil {
			return nil, err
		}
		out.Files = append(out.Files, OutFile{Name: "php-fpm.conf", Content: pool})
	}
	if out.Placeholder {
		out.Files = append(out.Files, OutFile{Name: placeholderMarker, Content: cfg.Docroot + "\n"})
	}
	sort.Slice(out.Files, func(i, j int) bool { return out.Files[i].Name < out.Files[j].Name })
	return out, nil
}

func customFileContent(c CustomRules) string {
	if c.Content == "" {
		if c.Rejected != "" {
			return "# Custom nginx rules DISABLED by siteconf: " + strings.ReplaceAll(c.Rejected, "\n", " ") + "\n"
		}
		return "# No custom nginx rules.\n"
	}
	return c.Content
}

func execute(name string, d templateData) (string, error) {
	var buf bytes.Buffer
	if err := templates.ExecuteTemplate(&buf, name, d); err != nil {
		return "", fmt.Errorf("render %s: %w", name, err)
	}
	return collapseBlankLines(buf.String()), nil
}

// collapseBlankLines keeps generated files tidy (no runs of empty lines).
func collapseBlankLines(s string) string {
	lines := strings.Split(s, "\n")
	outLines := make([]string, 0, len(lines))
	blank := 0
	for _, l := range lines {
		l = strings.TrimRight(l, " \t")
		if l == "" {
			blank++
			if blank > 1 {
				continue
			}
		} else {
			blank = 0
		}
		outLines = append(outLines, l)
	}
	return strings.TrimLeft(strings.Join(outLines, "\n"), "\n")
}

// dataPathViews: the web-server rules built from these views match a data path
// at its NORMAL location only (Apache <Directory>/<DirectoryMatch> and nginx
// locations see the unresolved path). A release symlink pointing into
// /srv/data (e.g. Laravel public/storage) reaches it under another URL where
// these rules do not apply. Apache: such links are found in the served tree
// (datalinks.go) and get their own sections (dataLinkViews); nginx reads no
// per-directory file and PHP there is stopped by guard.php (realpath).
func dataPathViews(cfg *SiteConfig) ([]dataPathView, error) {
	root := cfg.DocrootRel()
	paths := append([]DataPath(nil), cfg.DataPaths...)
	sort.Slice(paths, func(i, j int) bool { return paths[i].Path < paths[j].Path })
	views := make([]dataPathView, 0, len(paths))
	for _, p := range paths {
		re, err := pathRegex(p.Path)
		if err != nil {
			return nil, err
		}
		v := dataPathView{
			Path:         p.Path,
			Policy:       p.Policy,
			Typed:        p.Policy == PolicyTyped,
			CurrentDir:   currentRelease + "/" + p.Path,
			ReleaseRegex: releasesRoot + "/[^/]+/" + re,
		}
		if v.Typed {
			v.Extensions = append([]string(nil), p.AllowedExtensions...)
			sort.Strings(v.Extensions)
		}
		switch {
		case root == "":
			v.URLPrefix = cfg.BasePath + p.Path + "/"
		case strings.HasPrefix(p.Path, root+"/"):
			v.URLPrefix = cfg.BasePath + strings.TrimPrefix(p.Path, root+"/") + "/"
		}
		views = append(views, v)
	}
	return views, nil
}

// phpExcludeRegex: REQUEST_FILENAME values Apache must never hand to php-fpm
// (data paths of any release, plus the release directories that are links
// into /srv/data — linkRegexes, already quoted by bytesRegex).
func phpExcludeRegex(views []dataPathView, linkRegexes []string) (string, error) {
	if len(views) == 0 && len(linkRegexes) == 0 {
		return "^/srv/data/", nil
	}
	alts := make([]string, 0, len(views)+len(linkRegexes))
	for _, v := range views {
		re, err := pathRegex(v.Path)
		if err != nil {
			return "", err
		}
		alts = append(alts, re)
	}
	for _, re := range linkRegexes {
		if !safeRegexRE.MatchString(re) || strings.ContainsAny(re, "\"#\n") {
			return "", fmt.Errorf("refusing unsafe path regex %q", re)
		}
		alts = append(alts, re)
	}
	return "^/srv/(?:data/|releases/[^/]+/(?:" + strings.Join(alts, "|") + ")(?:/|$))", nil
}

// safeByte: bytes written as is in a path (aq whitelist minus ':' and '=').
func safeByte(b byte) bool {
	return b >= 'a' && b <= 'z' || b >= 'A' && b <= 'Z' || b >= '0' && b <= '9' ||
		b == '.' || b == '_' || b == '@' || b == '+' || b == '-' || b == '/'
}

// globPath: an on-disk path for an Apache wildcard <Directory>: every byte
// outside the whitelist (space, quote, '*', '?', '[', non-ASCII…) becomes "?"
// (one byte). Over-matching a same-length sibling only disables ITS
// .htaccess — the safe side.
func globPath(p string) string {
	b := []byte(p)
	for i := range b {
		if !safeByte(b[i]) {
			b[i] = '?'
		}
	}
	return string(b)
}

// bytesRegex: PCRE of a relative on-disk path, unsafe bytes as ".".
func bytesRegex(p string) string {
	var sb strings.Builder
	for i := 0; i < len(p); i++ {
		c := p[i]
		switch {
		case !safeByte(c):
			sb.WriteByte('.')
		case c == '.' || c == '+':
			sb.WriteByte('\\')
			sb.WriteByte(c)
		default:
			sb.WriteByte(c)
		}
	}
	return sb.String()
}

// dataLinkViews turns the discovered links into Apache sections. A link
// standing at a data path's own location is already covered by that data
// path. The policy is the one of the data path the target falls in; a target
// CONTAINING a typed path (link to /srv/data itself…) denies everything.
func dataLinkViews(cfg *SiteConfig, links []DataLink) ([]dataLinkView, []string) {
	covered := map[string]bool{}
	for _, d := range cfg.DataPaths {
		covered[d.Path] = true
	}
	var views []dataLinkView
	var regexes []string
	done := map[string]bool{}
	for _, l := range links {
		if !l.HtaccessOnly && covered[l.Dir] {
			continue
		}
		dir := currentRelease
		if l.Dir != "" {
			dir += "/" + l.Dir
		}
		v := dataLinkView{CurrentDir: globPath(dir), Data: !l.HtaccessOnly}
		key := fmt.Sprintf("%t %s", v.Data, v.CurrentDir)
		if done[key] {
			continue
		}
		done[key] = true
		target := dataRoot
		if l.DataRel != "" {
			target += "/" + l.DataRel
		}
		if l.HtaccessOnly {
			v.Comment = fmt.Sprintf("%s/.htaccess -> %s: never read", v.CurrentDir, globPath(target))
			views = append(views, v)
			continue
		}
		v.Comment = fmt.Sprintf("%s -> %s", v.CurrentDir, globPath(target))
		for _, d := range cfg.DataPaths {
			if d.Policy != PolicyTyped {
				continue
			}
			switch {
			case underDir(l.DataRel, d.Path):
				v.Typed = true
				v.Extensions = append([]string(nil), d.AllowedExtensions...)
				sort.Strings(v.Extensions)
			case l.DataRel == "" || strings.HasPrefix(d.Path, l.DataRel+"/"):
				v.Typed, v.Extensions = true, nil
			}
			if v.Typed {
				break
			}
		}
		views = append(views, v)
		if l.Dir != "" {
			regexes = append(regexes, bytesRegex(l.Dir))
		}
	}
	return views, regexes
}
