package main

// OpenLiteSpeed (litespeed-php8.x bases): httpd_config.conf + vhost.conf
// (plain-text configuration, read at start and at every graceful restart) and
// the lsphp ini of the site.
//
// How the "data is never code" rule maps onto OpenLiteSpeed:
//
//   - OpenLiteSpeed reads only the REWRITE directives of .htaccess files, and
//     only in the directories it walks while matching a prefix context
//     (HttpVHost::bestMatch, autoLoadHtaccess). It does not honour
//     "RewriteEngine Off" from the server side: a rewrite-disabled context is
//     re-enabled by a .htaccess "RewriteEngine On". The regex contexts of the
//     VIRTUAL HOST ROOT are matched BEFORE that walk (HttpReq::processContext
//     → processMatchList) and, when one matches, the walk never happens. Every
//     data path (and every release link into /srv/data) is therefore served
//     by a root regex context `exp:^<url prefix>(.*)$` whose location is the
//     data directory: no .htaccess written by PHP in /srv/data is ever read.
//   - PHP-like names under a data path are refused by an earlier regex context
//     (contexts are sorted by URI before matching: "(?i)…" sorts before "^…");
//     PHP variants other than .php are refused everywhere (source disclosure),
//     hidden files too (.htaccess, .user.ini, .git, .env…; .well-known is
//     served).
//   - `typed`: one context per allowed extension list, the rest of the path is
//     refused.
//   - lsphp: open_basedir, auto_prepend_file (guard.php) and oblimint.exec_dirs
//     come from an ini file of the scan directory (system level). lsphp reads
//     no .user.ini (LSPHP_ENABLE_USER_INI is never set) and OpenLiteSpeed
//     passes no php_value from .htaccess, so neither can switch the guard off.
//
// Every value reaching the templates goes through lsv / lsPath (whitelists
// that FAIL instead of escaping), like the Apache / nginx renderers.

import (
	"fmt"
	"path"
	"regexp"
	"sort"
	"strings"
)

// lsContext: one `context` block of vhost.conf.
type lsContext struct {
	Comment string
	// URI: "/prefix/" or "exp:<regex>".
	URI string
	// Location: file system target ("" = mapped under the docroot).
	Location string
	// Allow: allowBrowse 1 (served) or 0 (403).
	Allow bool
	// ForceType: served as this MIME type ("" = by suffix).
	ForceType string
	// NoRewrite: `rewrite { enable 0 }` (no rule of the site applies here).
	NoRewrite bool
}

// lsDataView: the regex contexts of one data path / data link.
type lsDataView struct {
	Comment  string
	Contexts []lsContext
}

const (
	lsPHPLike     = `\.(php[0-9]?|phar|phtml|pht|phps)(/|$)`
	lsPHPVariants = `\.(php[0-9]|phar|phtml|pht|phps)(/|$)`
	// Hidden files and directories (.htaccess, .user.ini, .git, .env…) are
	// never served; RFC 8615 /.well-known/ is. "(?:" makes it sort FIRST among
	// the regex contexts (OpenLiteSpeed sorts the contexts by URI and the first
	// matching regex wins): a hidden file under a typed data path is refused
	// even when its extension is allowed.
	lsHiddenRegex = `(?:/\.(?!well-known(/|$)))`
	// lsphp pool: like the php-fpm pools (pm.max_children = 8).
	lsphpChildren = 8
	// Largest page LSCache stores (bytes): the store is a small tmpfs.
	lsMaxCacheObj = 4 * 1024 * 1024
)

var (
	// OpenLiteSpeed config values: no whitespace, no braces (block syntax), no
	// '#' (comment), no quotes, no control characters.
	lsValueRE = regexp.MustCompile(`^[A-Za-z0-9._@+/:=?!$|*^()\[\]\\,-]+$`)
	lsGenRE   = regexp.MustCompile(`^[A-Za-z0-9]{1,32}$`)
)

// lsv checks a bare OpenLiteSpeed value (URI regex, location…).
func lsv(v string) (string, error) {
	if !lsValueRE.MatchString(v) {
		return "", fmt.Errorf("refusing unsafe OpenLiteSpeed value %q", v)
	}
	return v, nil
}

// lsDirectoryContexts: the regex contexts serving `dir` (container path, no
// trailing slash) under the URL `prefix` (ends with '/'), with the data rules.
// typed: only `exts` are served (empty = nothing).
func lsDirectoryContexts(prefix, dir string, typed bool, exts []string) ([]lsContext, error) {
	re, err := pathRegex(prefix)
	if err != nil {
		return nil, err
	}
	if !safeValueRE.MatchString(dir) {
		return nil, fmt.Errorf("refusing unsafe data directory %q", dir)
	}
	ctx := []lsContext{{
		URI:   "exp:(?i)^" + re + ".*" + lsPHPLike,
		Allow: false,
	}}
	location := dir + "/$1"
	if typed {
		if len(exts) > 0 {
			list, err := joinExt(exts, "|")
			if err != nil {
				return nil, err
			}
			ctx = append(ctx, lsContext{
				URI:       "exp:(?i)^" + re + "(.*\\.(?:" + list + "))$",
				Location:  location,
				Allow:     true,
				NoRewrite: true,
			})
		}
		ctx = append(ctx, lsContext{URI: "exp:^" + re, Allow: false, NoRewrite: true})
		return ctx, nil
	}
	ctx = append(ctx, lsContext{URI: "exp:^" + re + "(.*)$", Location: location, Allow: true, NoRewrite: true})
	return ctx, nil
}

// urlPrefixOf: URL prefix of the release directory `rel` ("" = outside the docroot).
func urlPrefixOf(cfg *SiteConfig, rel string) string {
	root := cfg.DocrootRel()
	switch {
	case root == "":
		return cfg.BasePath + rel + "/"
	case strings.HasPrefix(rel, root+"/"):
		return cfg.BasePath + strings.TrimPrefix(rel, root+"/") + "/"
	}
	return ""
}

// lsDataViews: data paths, then the release links into /srv/data found in the
// served tree (datalinks.go). A link whose on-disk name has bytes outside the
// whitelist cannot be mapped (warning): its content stays protected from PHP
// by guard.php and oblimint_exec, only its .htaccess would be read.
func lsDataViews(cfg *SiteConfig, views []dataPathView, links []DataLink) ([]lsDataView, []string, error) {
	var out []lsDataView
	var warnings []string
	for _, v := range views {
		if v.URLPrefix == "" {
			out = append(out, lsDataView{Comment: fmt.Sprintf("Data path %s (%s): outside the docroot, not web-reachable.", v.Path, v.Policy)})
			continue
		}
		ctx, err := lsDirectoryContexts(v.URLPrefix, v.CurrentDir, v.Typed, v.Extensions)
		if err != nil {
			return nil, nil, err
		}
		out = append(out, lsDataView{Comment: dataComment(v), Contexts: ctx})
	}
	covered := map[string]bool{}
	for _, d := range cfg.DataPaths {
		covered[d.Path] = true
	}
	done := map[string]bool{}
	for _, l := range links {
		if covered[l.Dir] && !l.HtaccessOnly {
			continue
		}
		dir := currentRelease
		if l.Dir != "" {
			dir += "/" + l.Dir
		}
		if done[dir] {
			continue
		}
		done[dir] = true
		if l.Dir != "" && globPath(l.Dir) != l.Dir {
			warnings = append(warnings, fmt.Sprintf("release link %s into /srv/data has unsafe bytes in its name: not mapped (its .htaccess may be read)", globPath(dir)))
			continue
		}
		prefix := ""
		if l.Dir == "" {
			if cfg.DocrootRel() == "" {
				prefix = cfg.BasePath
			}
		} else {
			prefix = urlPrefixOf(cfg, l.Dir)
		}
		if prefix == "" {
			continue // not web-reachable
		}
		target := dataRoot
		if l.DataRel != "" {
			target += "/" + l.DataRel
		}
		if l.HtaccessOnly {
			// The directory is code, only its .htaccess is data: a regex context
			// serves the directory without reading any .htaccess under it.
			re, err := pathRegex(prefix)
			if err != nil {
				return nil, nil, err
			}
			out = append(out, lsDataView{
				Comment:  fmt.Sprintf("%s/.htaccess -> %s: never read (rewrite rules of this directory are ignored)", dir, globPath(target)),
				Contexts: []lsContext{{URI: "exp:^" + re + "(.*)$", Location: dir + "/$1", Allow: true, NoRewrite: true}},
			})
			continue
		}
		typed, exts := false, []string(nil)
		for _, d := range cfg.DataPaths {
			if d.Policy != PolicyTyped {
				continue
			}
			switch {
			case underDir(l.DataRel, d.Path):
				typed, exts = true, append([]string(nil), d.AllowedExtensions...)
				sort.Strings(exts)
			case l.DataRel == "" || strings.HasPrefix(d.Path, l.DataRel+"/"):
				typed, exts = true, nil
			}
			if typed {
				break
			}
		}
		ctx, err := lsDirectoryContexts(prefix, dir, typed, exts)
		if err != nil {
			return nil, nil, err
		}
		out = append(out, lsDataView{Comment: fmt.Sprintf("%s -> %s", dir, globPath(target)), Contexts: ctx})
	}
	return out, warnings, nil
}

func dataComment(v dataPathView) string {
	c := fmt.Sprintf("Data path %s (%s", v.Path, v.Policy)
	if v.Typed {
		if len(v.Extensions) > 0 {
			c += ": " + strings.Join(v.Extensions, ", ")
		} else {
			c += ": nothing served"
		}
	}
	return c + ") — never executed, no .htaccess read."
}

// lsCacheStore: per-render generation directory of the cache tmpfs. A new
// generation at every render (start, oblimint-reload: publication, rollback,
// setting change, purge) = an empty page cache for the new configuration;
// the entrypoint removes the previous generations once the old workers are
// gone.
func lsCacheStore(dir, gen string) (string, error) {
	if dir == "" {
		dir = defaultLSCacheDir
	}
	if !strings.HasPrefix(dir, "/") || path.Clean(dir) != dir || !safeValueRE.MatchString(dir) {
		return "", fmt.Errorf("invalid LSCache directory %q", dir)
	}
	if gen == "" {
		gen = "0"
	}
	if !lsGenRE.MatchString(gen) {
		return "", fmt.Errorf("invalid LSCache generation %q", gen)
	}
	return path.Join(dir, gen), nil
}

// litespeedData fills the litespeed fields of the template data.
func litespeedData(d *templateData, cfg *SiteConfig, opt Options, views []dataPathView, links []DataLink, placeholder bool) ([]string, error) {
	store, err := lsCacheStore(opt.LSCacheDir, opt.LSCacheGen)
	if err != nil {
		return nil, err
	}
	bin := opt.LsphpBin
	if bin == "" {
		bin = "/usr/local/bin/lsphp"
	}
	d.LsphpBin = bin
	d.LsphpSocket = path.Join(opt.Out, lsphpSocketName)
	d.LsphpChildren = lsphpChildren
	d.LSCache = cfg.LSCacheEnabled()
	d.LSCacheStore = store
	d.LsMaxCacheObj = lsMaxCacheObj
	d.MimeTypes = opt.LswsMimeTypes
	if d.MimeTypes == "" {
		d.MimeTypes = "/usr/local/lsws/share/mime.properties"
	}
	if placeholder {
		return nil, nil
	}
	d.LsGlobal = []lsContext{
		{Comment: "Hidden files (.htaccess, .user.ini, .git, .env…) are never served; /.well-known/ is.", URI: "exp:" + lsHiddenRegex},
		{Comment: "Never source-disclose / run PHP variants other than .php.", URI: "exp:(?i)" + lsPHPVariants},
	}
	data, warnings, err := lsDataViews(cfg, views, links)
	if err != nil {
		return nil, err
	}
	d.LsData = data
	// Access control of the .htaccess files (htaccess.go): reproduced or closed.
	if opt.HtaccessAccess != nil {
		rules, w := opt.HtaccessAccess(cfg.Docroot)
		warnings = append(warnings, w...)
		dataDirs := make([]string, 0, len(cfg.DataPaths)+len(links))
		for _, p := range cfg.DataPaths {
			dataDirs = append(dataDirs, p.Path)
		}
		for _, k := range links {
			if !k.HtaccessOnly && k.Dir != "" {
				dataDirs = append(dataDirs, k.Dir)
			}
		}
		d.LsAccess = lsAccessContexts(cfg, rules, dataDirs)
	}
	return warnings, nil
}

// renderLitespeed: lsws/httpd_config.conf, lsws/vhost.conf, lsphp/site.ini
// (with --php-fpm: the PHP settings of the site), placeholder marker.
func renderLitespeed(out *Output, cfg *SiteConfig, opt Options, d templateData) (*Output, error) {
	// basePath ≠ '/': the www/ tree of the nginx bases (<out>/www/<basePath> →
	// docroot), so that URLs outside the prefix find nothing (404).
	d.LsDocRoot = d.NginxRoot
	for _, f := range [][2]string{{"lsws.conf.tmpl", "lsws/httpd_config.conf"}, {"lsws-vhost.conf.tmpl", "lsws/vhost.conf"}} {
		content, err := execute(f[0], d)
		if err != nil {
			return nil, err
		}
		out.Files = append(out.Files, OutFile{Name: f[1], Content: content})
	}
	if opt.PHPFPM {
		ini, err := execute("lsphp.ini.tmpl", d)
		if err != nil {
			return nil, err
		}
		out.Files = append(out.Files, OutFile{Name: "lsphp/site.ini", Content: ini})
	}
	if out.Placeholder {
		out.Files = append(out.Files, OutFile{Name: placeholderMarker, Content: cfg.Docroot + "\n"})
	}
	sort.Slice(out.Files, func(i, j int) bool { return out.Files[i].Name < out.Files[j].Name })
	return out, nil
}
