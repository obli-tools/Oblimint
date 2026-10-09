package main

// oblimint.exec_dirs — where php-fpm may compile PHP at all (images/php/
// oblimint_exec). guard.php and the web-server rules only judge the MAIN
// script of a request; this list is enforced by the engine on EVERY file it
// compiles (include / require / *_once / auto_prepend_file), on the real path:
//
//   - the release (/srv/releases/, read-only) and the guard (/opt/oblimint/);
//   - `ephemeral` data paths: regenerable caches (wp-content/cache, PrestaShop
//     var/cache, Laravel bootstrap/cache…) that the frameworks compile PHP
//     into and include; they are emptied at every publication and restart;
//   - inside `persistent` data paths, ONLY the known framework code
//     directories of frameworkCodeDirs.
//
// Everything else is never compiled: /tmp (uploads in transit, sessions),
// `typed` data paths, user content (wp-content/uploads, storage/app, Drupal
// files outside php/, PrestaShop upload/download…). A file planted there —
// by an SFTP user, an application file-write bug or a compromised site — stays
// inert even when release code (or an LFI) includes it, and cannot survive a
// release switch as code.

import (
	"fmt"
	"path"
	"sort"
	"strings"
)

// frameworkCodeDirs: directories inside persistent data paths where the
// supported frameworks keep PHP they include at run time.
var frameworkCodeDirs = []string{
	"app/config",              // PrestaShop 1.7+: parameters.php (installer / back office)
	"sites/default/files/php", // Drupal: compiled Twig templates (php_storage)
	"storage/framework/views", // Laravel: compiled Blade templates
}

// execDirs returns the ':'-separated list of real-path prefixes (each ending
// with '/') written to php_admin_value[oblimint.exec_dirs].
func execDirs(cfg *SiteConfig) (string, error) {
	dirs := []string{releasesRoot + "/", path.Dir(guardFile) + "/"}
	seen := map[string]bool{}
	var extra []string
	add := func(rel string) {
		d := dataRoot + "/" + rel + "/"
		if !seen[d] {
			seen[d] = true
			extra = append(extra, d)
		}
	}
	for _, p := range cfg.DataPaths {
		switch p.Policy {
		case PolicyEphemeral:
			add(p.Path)
		case PolicyPersistent:
			for _, c := range frameworkCodeDirs {
				switch {
				case c == p.Path || strings.HasPrefix(c, p.Path+"/"):
					add(c) // the data path contains the code directory
				case strings.HasPrefix(p.Path, c+"/"):
					add(p.Path) // the data path lies inside it
				}
			}
		}
		// PolicyTyped: media only, never code.
	}
	sort.Strings(extra)
	dirs = append(dirs, extra...)
	for _, d := range dirs {
		// Validated relative paths only produce [A-Za-z0-9._@+/-]; ':' is the
		// list separator and '"' would end the quoted ini value.
		if !safeValueRE.MatchString(d) || strings.ContainsAny(d, `:"`) || path.Clean(d)+"/" != d {
			return "", fmt.Errorf("refusing unsafe exec dir %q", d)
		}
	}
	return strings.Join(dirs, ":"), nil
}
