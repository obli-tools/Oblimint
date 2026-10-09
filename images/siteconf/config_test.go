package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func validConfig() map[string]any {
	return map[string]any{
		"version":        1,
		"siteId":         12,
		"accountId":      3,
		"role":           "primary",
		"base":           "apache-php8.3",
		"docroot":        "/srv/releases/current",
		"basePath":       "/",
		"servedPrefixes": []any{},
		"dataPaths": []any{
			map[string]any{"path": "wp-content/uploads", "policy": "persistent", "allowedExtensions": nil},
		},
		"php":             map[string]any{"memoryLimitMb": 256, "uploadMaxFilesizeMb": 64, "postMaxSizeMb": 64, "maxExecutionTime": 60},
		"customNginx":     nil,
		"healthcheckPath": "/",
	}
}

func parseMap(t *testing.T, m map[string]any) (*SiteConfig, error) {
	t.Helper()
	b, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	return ParseConfig(strings.NewReader(string(b)))
}

func TestValidConfig(t *testing.T) {
	if _, err := parseMap(t, validConfig()); err != nil {
		t.Fatalf("valid config refused: %v", err)
	}
}

func TestValidationTable(t *testing.T) {
	dp := func(path, policy string, ext any) []any {
		return []any{map[string]any{"path": path, "policy": policy, "allowedExtensions": ext}}
	}
	cases := []struct {
		name  string
		key   string
		value any
	}{
		{"version 2", "version", 2},
		{"version 0", "version", 0},
		{"site id 0", "siteId", 0},
		{"negative account", "accountId", -1},
		{"role", "role", "secondary-3"},
		{"base", "base", "apache-php5.6"},
		{"base case", "base", "Apache-php8.3"},
		{"docroot relative", "docroot", "srv/releases/current"},
		{"docroot other release", "docroot", "/srv/releases/12"},
		{"docroot traversal", "docroot", "/srv/releases/current/../../etc"},
		{"docroot dot", "docroot", "/srv/releases/current/./public"},
		{"docroot trailing slash", "docroot", "/srv/releases/current/public/"},
		{"docroot double slash", "docroot", "/srv/releases/current//public"},
		{"docroot space", "docroot", "/srv/releases/current/my public"},
		{"docroot quote", "docroot", `/srv/releases/current/a"b`},
		{"docroot newline", "docroot", "/srv/releases/current/a\nLoadModule x"},
		{"docroot data", "docroot", "/srv/data"},
		{"basePath empty", "basePath", ""},
		{"basePath no trailing", "basePath", "/blog"},
		{"basePath no leading", "basePath", "blog/"},
		{"basePath dotdot", "basePath", "/../"},
		{"basePath double", "basePath", "//"},
		{"basePath brace", "basePath", "/a}/"},
		{"basePath semicolon", "basePath", "/a;b/"},
		{"basePath space", "basePath", "/a b/"},
		{"served prefix", "servedPrefixes", []any{"/forum"}},
		{"data path absolute", "dataPaths", dp("/wp-content/uploads", "persistent", nil)},
		{"data path dotdot", "dataPaths", dp("wp-content/../x", "persistent", nil)},
		{"data path backslash", "dataPaths", dp(`wp-content\uploads`, "persistent", nil)},
		{"data path empty", "dataPaths", dp("", "persistent", nil)},
		{"data path quote", "dataPaths", dp(`up"loads`, "persistent", nil)},
		{"data path newline", "dataPaths", dp("uploads\n</Directory>", "persistent", nil)},
		{"data path semicolon", "dataPaths", dp("uploads;", "persistent", nil)},
		{"data path brace", "dataPaths", dp("uploads}", "persistent", nil)},
		{"data path hash", "dataPaths", dp("up#loads", "persistent", nil)},
		{"data path regex", "dataPaths", dp("up(.*)", "persistent", nil)},
		{"policy", "dataPaths", dp("uploads", "exec", nil)},
		{"extension upper", "dataPaths", dp("img", "typed", []any{"JPG"})},
		{"extension dot", "dataPaths", dp("img", "typed", []any{".jpg"})},
		{"extension long", "dataPaths", dp("img", "typed", []any{"abcdefghijk"})},
		{"extension pipe", "dataPaths", dp("img", "typed", []any{"jpg|php"})},
		{"extension paren", "dataPaths", dp("img", "typed", []any{"jpg)$"})},
		{"extension php", "dataPaths", dp("img", "typed", []any{"php"})},
		{"extension php7", "dataPaths", dp("img", "typed", []any{"php7"})},
		{"extension phar", "dataPaths", dp("img", "typed", []any{"phar"})},
		{"extension phtml", "dataPaths", dp("img", "typed", []any{"phtml"})},
		{"extension dup", "dataPaths", dp("img", "typed", []any{"jpg", "jpg"})},
		{"extension empty", "dataPaths", dp("img", "typed", []any{""})},
		{"memory low", "php", map[string]any{"memoryLimitMb": 1, "uploadMaxFilesizeMb": 64, "postMaxSizeMb": 64, "maxExecutionTime": 60}},
		{"upload zero", "php", map[string]any{"memoryLimitMb": 256, "uploadMaxFilesizeMb": 0, "postMaxSizeMb": 64, "maxExecutionTime": 60}},
		{"post huge", "php", map[string]any{"memoryLimitMb": 256, "uploadMaxFilesizeMb": 64, "postMaxSizeMb": 999999, "maxExecutionTime": 60}},
		{"exec zero", "php", map[string]any{"memoryLimitMb": 256, "uploadMaxFilesizeMb": 64, "postMaxSizeMb": 64, "maxExecutionTime": 0}},
		{"php missing", "php", map[string]any{}},
		{"php string", "php", map[string]any{"memoryLimitMb": "256M", "uploadMaxFilesizeMb": 64, "postMaxSizeMb": 64, "maxExecutionTime": 60}},
		{"healthcheck", "healthcheckPath", "no-slash"},
		{"healthcheck space", "healthcheckPath", "/a b"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			m := validConfig()
			m[tc.key] = tc.value
			if _, err := parseMap(t, m); err == nil {
				t.Fatalf("%s=%#v accepted", tc.key, tc.value)
			}
		})
	}
}

func TestDataPathOverlapAndDocroot(t *testing.T) {
	m := validConfig()
	m["dataPaths"] = []any{
		map[string]any{"path": "wp-content", "policy": "persistent", "allowedExtensions": nil},
		map[string]any{"path": "wp-content/uploads", "policy": "persistent", "allowedExtensions": nil},
	}
	if _, err := parseMap(t, m); err == nil || !strings.Contains(err.Error(), "overlaps") {
		t.Fatalf("overlap accepted: %v", err)
	}
	m = validConfig()
	m["dataPaths"] = []any{
		map[string]any{"path": "a", "policy": "persistent", "allowedExtensions": nil},
		map[string]any{"path": "a", "policy": "ephemeral", "allowedExtensions": nil},
	}
	if _, err := parseMap(t, m); err == nil {
		t.Fatal("duplicate data path accepted")
	}
	// Siblings sharing a name prefix are NOT overlapping.
	m = validConfig()
	m["dataPaths"] = []any{
		map[string]any{"path": "cache", "policy": "ephemeral", "allowedExtensions": nil},
		map[string]any{"path": "cache2", "policy": "ephemeral", "allowedExtensions": nil},
	}
	if _, err := parseMap(t, m); err != nil {
		t.Fatalf("siblings refused: %v", err)
	}
	m = validConfig()
	m["docroot"] = "/srv/releases/current/public"
	m["dataPaths"] = []any{map[string]any{"path": "public", "policy": "persistent", "allowedExtensions": nil}}
	if _, err := parseMap(t, m); err == nil || !strings.Contains(err.Error(), "contains the docroot") {
		t.Fatalf("data path containing the docroot accepted: %v", err)
	}
}

func TestParseRejectsGarbage(t *testing.T) {
	for _, in := range []string{
		"",
		"[]",
		"{",
		`{"version":1}{"version":1}`,
		`{"version":1,"siteId":"12"}`,
		strings.Repeat(" ", maxConfigBytes+1),
	} {
		if _, err := ParseConfig(strings.NewReader(in)); err == nil {
			t.Errorf("accepted %q", truncate(in))
		}
	}
}

func TestNormalizeRelPathTwin(t *testing.T) {
	// Same expectations as shared normalizeRelPath().
	cases := []struct {
		in    string
		empty bool
		want  string
		ok    bool
	}{
		{"wp-content/uploads", false, "wp-content/uploads", true},
		{" /wp-content/uploads/ ", false, "wp-content/uploads", true},
		{`wp-content\uploads`, false, "wp-content/uploads", true},
		{"", false, "", false},
		{"", true, "", true},
		{"/", true, "", true},
		{"a//b", false, "", false},
		{"a/./b", false, "", false},
		{"a/../b", false, "", false},
		{"a b", false, "", false},
		{"user@files+x.y_z-1", false, "user@files+x.y_z-1", true},
		{strings.Repeat("a", 256), false, "", false},
	}
	for _, tc := range cases {
		got, ok := NormalizeRelPath(tc.in, tc.empty)
		if got != tc.want || ok != tc.ok {
			t.Errorf("NormalizeRelPath(%q,%v) = %q,%v want %q,%v", tc.in, tc.empty, got, ok, tc.want, tc.ok)
		}
	}
}

func TestUnknownFieldsIgnored(t *testing.T) {
	m := validConfig()
	m["futureField"] = map[string]any{"x": 1}
	if _, err := parseMap(t, m); err != nil {
		t.Fatalf("unknown field refused: %v", err)
	}
}
