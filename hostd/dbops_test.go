package main

import (
	"errors"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

func provisionAccount(t *testing.T, h *hostOps) {
	t.Helper()
	if _, err := h.EnsureAccount(bg, AccountSpec{AccountID: 3, Owner: tenant}); err != nil {
		t.Fatal(err)
	}
}

func TestEnsureAccountCreatesDbDirs(t *testing.T) {
	h, _, dir := newTestOps(t)
	provisionAccount(t, h)
	for _, p := range []string{"dbsock", "dbsock/mysql", "dbsock/postgresql", "databases"} {
		if fi, err := os.Lstat(filepath.Join(dir, "accounts/3", p)); err != nil || !fi.IsDir() {
			t.Errorf("%s: %v", p, err)
		}
	}
}

func TestEnsureAndRemoveDbInstance(t *testing.T) {
	h, rec, dir := newTestOps(t)
	// Account tree missing: 404, nothing created.
	if err := h.EnsureDbInstance(bg, DbInstanceSpec{AccountID: 3, InstanceID: 12, Owner: tenant}); statusOf(err) != http.StatusNotFound {
		t.Fatalf("missing account: %v", err)
	}
	provisionAccount(t, h)
	rec.reset()
	spec := DbInstanceSpec{AccountID: 3, InstanceID: 12, Owner: tenant}
	if err := h.EnsureDbInstance(bg, spec); err != nil {
		t.Fatal(err)
	}
	assertOwners(t, rec, map[string]string{
		"accounts/3/dbsock/i-12":  "20001:20002 0750",
		"accounts/3/databases/12": "20001:20002 0700",
	})
	if err := h.EnsureDbInstance(bg, spec); err != nil {
		t.Fatalf("idempotent: %v", err)
	}
	mustWrite(t, filepath.Join(dir, "accounts/3/databases/12/ibdata1"), "data")

	// Invalid input never reaches the disk.
	for _, bad := range []DbInstanceSpec{{3, 0, tenant}, {0, 12, tenant}, {3, 12, Owner{0, 0}}} {
		if err := h.EnsureDbInstance(bg, bad); statusOf(err) != http.StatusBadRequest {
			t.Errorf("%+v: %v", bad, err)
		}
	}

	// purge=0: socket dir gone, data kept.
	if err := h.RemoveDbInstance(bg, 3, 12, false); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(filepath.Join(dir, "accounts/3/dbsock/i-12")); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("socket dir still there: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "accounts/3/databases/12/ibdata1")); err != nil {
		t.Errorf("purge=0 must keep the data: %v", err)
	}
	// purge=1: data gone; idempotent.
	if err := h.RemoveDbInstance(bg, 3, 12, true); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(filepath.Join(dir, "accounts/3/databases/12")); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("data dir still there: %v", err)
	}
	if err := h.RemoveDbInstance(bg, 3, 12, true); err != nil {
		t.Errorf("idempotent purge: %v", err)
	}
	if err := h.RemoveDbInstance(bg, 99, 12, true); err != nil {
		t.Errorf("missing account purge: %v", err)
	}
}

// symlinkSupported skips the test when this OS / user cannot create symlinks.
func symlinkSupported(t *testing.T) {
	t.Helper()
	d := t.TempDir()
	if err := os.Symlink("/run/x", filepath.Join(d, "probe")); err != nil {
		t.Skipf("symlinks unavailable here: %v", err)
	}
}

func TestDefaultDbSocketSwitch(t *testing.T) {
	symlinkSupported(t)
	h, _, dir := newTestOps(t)
	provisionAccount(t, h)
	mysqlDir := filepath.Join(dir, "accounts/3/dbsock/mysql")
	pgDir := filepath.Join(dir, "accounts/3/dbsock/postgresql")
	i12, i13 := int64(12), int64(13)

	if err := h.SetDefaultDbSocket(bg, 3, dbFamilyMySQL, &i12); err != nil {
		t.Fatal(err)
	}
	if got, err := os.Readlink(filepath.Join(mysqlDir, "mysqld.sock")); err != nil || got != "/run/oblimint-db/i-12/mysqld.sock" {
		t.Fatalf("link = %q %v", got, err)
	}
	// Switch: atomic rename, no temp link left behind.
	if err := h.SetDefaultDbSocket(bg, 3, dbFamilyMySQL, &i13); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.Readlink(filepath.Join(mysqlDir, "mysqld.sock")); got != "/run/oblimint-db/i-13/mysqld.sock" {
		t.Fatalf("switched link = %q", got)
	}
	entries, _ := os.ReadDir(mysqlDir)
	if len(entries) != 1 {
		t.Errorf("leftovers in %s: %v", mysqlDir, entries)
	}
	if err := h.SetDefaultDbSocket(bg, 3, dbFamilyMySQL, &i13); err != nil {
		t.Errorf("idempotent: %v", err)
	}
	if err := h.SetDefaultDbSocket(bg, 3, dbFamilyPostgreSQL, &i12); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.Readlink(filepath.Join(pgDir, ".s.PGSQL.5432")); got != "/run/oblimint-db/i-12/.s.PGSQL.5432" {
		t.Fatalf("pg link = %q", got)
	}

	// Removing instance 12 drops only the links pointing to it.
	if err := h.RemoveDbInstance(bg, 3, 12, false); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(filepath.Join(pgDir, ".s.PGSQL.5432")); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("pg link of the removed instance still there: %v", err)
	}
	if got, _ := os.Readlink(filepath.Join(mysqlDir, "mysqld.sock")); got != "/run/oblimint-db/i-13/mysqld.sock" {
		t.Errorf("mysql link of another instance touched: %q", got)
	}

	// null removes; removing again is fine.
	if err := h.SetDefaultDbSocket(bg, 3, dbFamilyMySQL, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(filepath.Join(mysqlDir, "mysqld.sock")); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("link not removed: %v", err)
	}
	if err := h.SetDefaultDbSocket(bg, 3, dbFamilyMySQL, nil); err != nil {
		t.Errorf("idempotent removal: %v", err)
	}
	// A regular file in place of the link is never removed as a link.
	mustWrite(t, filepath.Join(mysqlDir, "mysqld.sock"), "x")
	if err := h.SetDefaultDbSocket(bg, 3, dbFamilyMySQL, nil); statusOf(err) != http.StatusConflict {
		t.Errorf("file in place of the link: %v", err)
	}
}

// dbsock/ replaced by a link (never possible with root ownership, but hostd
// must not follow it anyway): every operation refuses.
func TestDbOpsNeverFollowLinks(t *testing.T) {
	h, _, dir := newTestOps(t)
	provisionAccount(t, h)
	outside := t.TempDir()
	sock := filepath.Join(dir, "accounts/3/dbsock")
	if err := os.RemoveAll(sock); err != nil {
		t.Fatal(err)
	}
	dirLinkOrSkip(t, outside, sock)
	i12 := int64(12)
	if err := h.EnsureDbInstance(bg, DbInstanceSpec{3, 12, tenant}); statusOf(err) != http.StatusConflict {
		t.Errorf("ensure through a link: %v", err)
	}
	if err := h.SetDefaultDbSocket(bg, 3, dbFamilyMySQL, &i12); statusOf(err) != http.StatusConflict {
		t.Errorf("default through a link: %v", err)
	}
	if entries, _ := os.ReadDir(outside); len(entries) != 0 {
		t.Errorf("something was created outside: %v", entries)
	}
}
