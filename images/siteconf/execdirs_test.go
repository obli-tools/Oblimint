package main

import (
	"strings"
	"testing"
)

// The engine-level "data is never code" rule (oblimint_exec): php-fpm only
// compiles PHP from the release, the guard and the framework code caches.
// Regression for the audit finding "include/require executes PHP living in
// writable data paths (/srv/data) and /tmp".

func execDirsOf(t *testing.T, cfg *SiteConfig) []string {
	t.Helper()
	s, err := execDirs(cfg)
	if err != nil {
		t.Fatal(err)
	}
	return strings.Split(s, ":")
}

func contains(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

func TestExecDirsNeverDataOrTmp(t *testing.T) {
	for _, name := range []string{"wordpress.json", "prestashop.json", "laravel-blog.json", "static.json"} {
		cfg := mustLoad(t, name)
		dirs := execDirsOf(t, cfg)
		if dirs[0] != "/srv/releases/" || dirs[1] != "/opt/oblimint/" {
			t.Errorf("%s: release and guard must come first: %v", name, dirs)
		}
		for _, d := range dirs {
			switch {
			case !strings.HasPrefix(d, "/") || !strings.HasSuffix(d, "/"):
				t.Errorf("%s: %q is not an absolute directory prefix", name, d)
			case d == "/" || d == "/srv/" || d == dataRoot+"/" || strings.HasPrefix(d, "/tmp"):
				t.Errorf("%s: %q must never be executable", name, d)
			case strings.HasPrefix(d, dataRoot+"/"):
				rel := strings.TrimSuffix(strings.TrimPrefix(d, dataRoot+"/"), "/")
				for _, p := range cfg.DataPaths {
					if p.Policy == PolicyTyped && (rel == p.Path || strings.HasPrefix(rel, p.Path+"/")) {
						t.Errorf("%s: typed data path %q is executable", name, p.Path)
					}
					if p.Policy == PolicyPersistent && rel == p.Path && !contains(frameworkCodeDirs, rel) {
						t.Errorf("%s: whole persistent data path %q is executable", name, p.Path)
					}
				}
			}
		}
	}
}

func TestExecDirsPerPolicy(t *testing.T) {
	cfg := mustLoad(t, "wordpress.json")
	got, err := execDirs(cfg)
	if err != nil {
		t.Fatal(err)
	}
	// uploads (persistent, user content) is NOT executable; the caches are.
	want := "/srv/releases/:/opt/oblimint/:/srv/data/wp-content/cache/:/srv/data/wp-content/upgrade/"
	if got != want {
		t.Fatalf("wordpress exec dirs:\n got %s\nwant %s", got, want)
	}

	cfg = mustLoad(t, "prestashop.json")
	dirs := execDirsOf(t, cfg)
	if !contains(dirs, "/srv/data/var/cache/") {
		t.Errorf("PrestaShop var/cache (ephemeral, Symfony container / Smarty) must stay executable: %v", dirs)
	}
	for _, d := range []string{"/srv/data/img/", "/srv/data/upload/", "/srv/data/themes/cache/"} {
		if contains(dirs, d) {
			t.Errorf("%s must not be executable: %v", d, dirs)
		}
	}
}

func TestExecDirsFrameworkCodeInsidePersistent(t *testing.T) {
	cases := []struct {
		dataPath string
		policy   DataPolicy
		want     []string
		notWant  []string
	}{
		// Laravel: storage is persistent (uploads in storage/app) but the
		// compiled Blade views are included.
		{"storage", PolicyPersistent, []string{"/srv/data/storage/framework/views/"}, []string{"/srv/data/storage/"}},
		// Drupal: only the php_storage directory, never the public files.
		{"sites/default/files", PolicyPersistent, []string{"/srv/data/sites/default/files/php/"}, []string{"/srv/data/sites/default/files/"}},
		// PrestaShop: parameters.php.
		{"app/config", PolicyPersistent, []string{"/srv/data/app/config/"}, nil},
		// A data path INSIDE a code directory.
		{"storage/framework/views/sub", PolicyPersistent, []string{"/srv/data/storage/framework/views/sub/"}, nil},
		// Typed never, even on a framework name.
		{"storage", PolicyTyped, nil, []string{"/srv/data/storage/framework/views/", "/srv/data/storage/"}},
		// Unrelated persistent path: nothing.
		{"wp-content/uploads", PolicyPersistent, nil, []string{"/srv/data/wp-content/uploads/"}},
	}
	for _, tc := range cases {
		cfg := mustLoad(t, "wordpress.json")
		cfg.DataPaths = []DataPath{{Path: tc.dataPath, Policy: tc.policy}}
		dirs := execDirsOf(t, cfg)
		for _, w := range tc.want {
			if !contains(dirs, w) {
				t.Errorf("%s (%s): %s missing from %v", tc.dataPath, tc.policy, w, dirs)
			}
		}
		for _, n := range tc.notWant {
			if contains(dirs, n) {
				t.Errorf("%s (%s): %s must not be executable: %v", tc.dataPath, tc.policy, n, dirs)
			}
		}
	}
}

func TestPoolSetsExecDirs(t *testing.T) {
	cfg := mustLoad(t, "laravel-blog.json")
	for _, engine := range []Engine{EngineApache, EngineNginx} {
		for _, present := range []bool{true, false} { // site and placeholder modes
			pool := renderFile(t, cfg, testOptions(engine, true, present), "php-fpm.conf")
			// php_admin_value: neither ini_set() nor php_value / .user.ini can widen it.
			mustContain(t, pool, `php_admin_value[oblimint.exec_dirs] = "/srv/releases/:/opt/oblimint/:/srv/data/storage/framework/views/"`)
			if strings.Contains(pool, "php_value[oblimint.") {
				t.Error("exec_dirs must be a php_admin_value")
			}
		}
	}
}
