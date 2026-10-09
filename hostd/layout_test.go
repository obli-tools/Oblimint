package main

import (
	"errors"
	"net/http"
	"slices"
	"strings"
	"testing"
)

// Expected strings are those of server/src/services/hosting/paths.ts
// (hostingLayout('/srv/oblimint')): both sides must agree.
func TestLayoutMatchesPanel(t *testing.T) {
	l := newLayout("")
	cases := map[string]string{
		l.Root:                    "/srv/oblimint",
		l.AccountsRoot():          "/srv/oblimint/accounts",
		l.Account(7):              "/srv/oblimint/accounts/7",
		l.Staging(7):              "/srv/oblimint/accounts/7/staging",
		l.SiteStaging(7, "blog"):  "/srv/oblimint/accounts/7/staging/blog",
		l.Data(7):                 "/srv/oblimint/accounts/7/data",
		l.SiteData(7, "blog"):     "/srv/oblimint/accounts/7/data/blog",
		l.FileServerState(7):      "/srv/oblimint/accounts/7/filesrv",
		l.Site(7, 42):             "/srv/oblimint/accounts/7/sites/42",
		l.Releases(7, 42):         "/srv/oblimint/accounts/7/sites/42/releases",
		l.Runtime(7, 42):          "/srv/oblimint/accounts/7/sites/42/runtime",
		l.RunDir():                "/srv/oblimint/run",
		newLayout("/data/").Root:  "/data",
		newLayout(`C:\x\y`).Root:  "C:/x/y",
		newLayout("/").Account(1): "/accounts/1",
	}
	for got, want := range cases {
		if got != want {
			t.Errorf("got %q, want %q", got, want)
		}
	}
	if projectID(7) != 100007 {
		t.Errorf("projectID(7) = %d", projectID(7))
	}
}

func TestLayoutTrees(t *testing.T) {
	l := newLayout("")
	o := Owner{20001, 20001}
	var got []string
	for _, d := range l.accountDirs(3, o) {
		got = append(got, d.String())
	}
	for _, d := range l.siteDirs(3, 9, "shop", o) {
		got = append(got, d.String())
	}
	want := []string{
		"accounts/3 0:0 0711",
		"accounts/3/staging 20001:20001 0750",
		"accounts/3/data 0:20001 0750",
		"accounts/3/filesrv 20001:20001 0700",
		"accounts/3/sites 0:0 0711",
		"accounts/3/staging/shop 20001:20001 0750",
		"accounts/3/data/shop 20001:20001 0750",
		"accounts/3/sites/9 0:0 0755",
		"accounts/3/sites/9/releases 0:0 0755",
		"accounts/3/sites/9/runtime 0:0 0755",
	}
	if !slices.Equal(got, want) {
		t.Errorf("trees:\n got %q\nwant %q", got, want)
	}
}

func isBadRequest(err error) bool {
	var ae *apiError
	return errors.As(err, &ae) && ae.Status == http.StatusBadRequest
}

func TestValidateSlug(t *testing.T) {
	ok := []string{"a", "0", "blog", "my-shop-2", strings.Repeat("a", 40)}
	bad := []string{"", "-a", "Blog", "a_b", "a.b", "a/b", "..", strings.Repeat("a", 41), "é", "a b", "a\x00"}
	for _, s := range ok {
		if err := validateSlug(s); err != nil {
			t.Errorf("slug %q refused: %v", s, err)
		}
	}
	for _, s := range bad {
		if err := validateSlug(s); !isBadRequest(err) {
			t.Errorf("slug %q accepted", s)
		}
	}
}

func TestSplitDataPath(t *testing.T) {
	ok := map[string][]string{
		"wp-content/uploads":     {"wp-content", "uploads"},
		"cache":                  {"cache"},
		"a/b.c/@d+e/F_1":         {"a", "b.c", "@d+e", "F_1"},
		"..a/.b":                 {"..a", ".b"},
		strings.Repeat("a", 255): {strings.Repeat("a", 255)},
	}
	for in, want := range ok {
		got, err := splitDataPath(in)
		if err != nil || !slices.Equal(got, want) {
			t.Errorf("splitDataPath(%q) = %v, %v", in, got, err)
		}
	}
	bad := []string{
		"", "/", "/abs", "trailing/", "a//b", ".", "..", "a/../b", "a/./b", "../etc",
		`a\b`, `..\x`, "a b", "é/x", "a/b\x00", "~/x", "a:b", "*", strings.Repeat("a", 256),
	}
	for _, in := range bad {
		if _, err := splitDataPath(in); !isBadRequest(err) {
			t.Errorf("splitDataPath(%q) accepted", in)
		}
	}
}

func TestParseIDAndOwner(t *testing.T) {
	for _, s := range []string{"1", "42", "2147483648"} {
		if _, err := parseID(s); err != nil {
			t.Errorf("parseID(%q): %v", s, err)
		}
	}
	for _, s := range []string{"", "0", "-1", "+1", "01", "1.0", "1e3", "abc", "99999999999999"} {
		if _, err := parseID(s); !isBadRequest(err) {
			t.Errorf("parseID(%q) accepted", s)
		}
	}
	if err := validateOwner(Owner{10000, 10000}); err != nil {
		t.Errorf("10000: %v", err)
	}
	for _, o := range []Owner{{0, 0}, {9999, 20000}, {20000, 9999}, {20000, -1}, {1 << 31, 20000}} {
		if err := validateOwner(o); !isBadRequest(err) {
			t.Errorf("owner %v accepted", o)
		}
	}
}

func TestRelFromAbs(t *testing.T) {
	l := newLayout("/srv/oblimint")
	ok := map[string][]string{
		"/srv/oblimint":                      {},
		"/srv/oblimint/accounts/3/data/blog": {"accounts", "3", "data", "blog"},
	}
	for in, want := range ok {
		got, err := l.RelFromAbs(in)
		if err != nil || !slices.Equal(got, want) {
			t.Errorf("RelFromAbs(%q) = %v, %v", in, got, err)
		}
	}
	bad := []string{
		"", "srv/oblimint", "/srv/oblimint/", "/srv/oblimint/../etc", "/srv/oblimint/a/./b",
		"/srv/oblimintx", "/srv", "/etc/passwd", "/srv/oblimint//a", "/srv/oblimint/a\x00",
	}
	for _, in := range bad {
		if _, err := l.RelFromAbs(in); !isBadRequest(err) {
			t.Errorf("RelFromAbs(%q) accepted", in)
		}
	}
}
