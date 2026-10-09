package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io/fs"
	"os"
)

// ─────────────────────────────────────────────────────────────────────────────
// P2 — database instance directories and default socket links
// (docs/P2-PLAN.md §4, invariant B1). Same rules as the P1 trees: every
// directory is entered without following links (R1), ownership and modes are
// applied through the descriptor, and the parents dbsock/ + databases/ (bind
// sources) are root-owned (R5 extended).
//
// The default links dbsock/<family>/<socket> point to an ABSOLUTE
// container-side path (/run/oblimint-db/i-<id>/<socket>): hostd creates and
// reads them with Symlink / Readlink, never resolves them.
// ─────────────────────────────────────────────────────────────────────────────

// DbInstanceSpec is the validated input of EnsureDbInstance.
type DbInstanceSpec struct {
	AccountID, InstanceID int64
	Owner                 Owner
}

func (s DbInstanceSpec) validate() error {
	if err := validateID("account id", s.AccountID); err != nil {
		return err
	}
	if err := validateID("instance id", s.InstanceID); err != nil {
		return err
	}
	return validateOwner(s.Owner)
}

var dbFamilies = []DbFamily{dbFamilyMySQL, dbFamilyPostgreSQL}

// EnsureDbInstance creates dbsock/i-<iid> (uid:gid 0750) and
// databases/<iid> (uid:gid 0700) below an existing account tree. Idempotent.
func (h *hostOps) EnsureDbInstance(ctx context.Context, s DbInstanceSpec) error {
	if err := s.validate(); err != nil {
		return err
	}
	unlock, err := h.lock(ctx, s.AccountID, quickLockWait)
	if err != nil {
		return err
	}
	defer unlock()
	root, err := h.openRoot()
	if err != nil {
		return err
	}
	defer root.Close()
	// The account tree (with dbsock/ and databases/) must exist: ensureAccount first.
	for _, rel := range [][]string{h.layout.DbSocketsRel(s.AccountID), h.layout.DatabasesRel(s.AccountID)} {
		d, err := h.open(rel)
		if err != nil {
			return err
		}
		d.Close()
	}
	return ensureTree(root, h.layout.dbInstanceDirs(s.AccountID, s.InstanceID, s.Owner), h.own)
}

// RemoveDbInstance removes the socket dir of an instance and the default
// links pointing to it; purge also removes its data directory. A purge waits
// for the account like the other purges (long operation).
func (h *hostOps) RemoveDbInstance(ctx context.Context, accountID, instanceID int64, purge bool) error {
	if err := validateID("account id", accountID); err != nil {
		return err
	}
	if err := validateID("instance id", instanceID); err != nil {
		return err
	}
	unlock, err := h.lock(ctx, accountID, lockWait(purge))
	if err != nil {
		return err
	}
	defer unlock()
	for _, f := range dbFamilies {
		if err := h.unlinkDefaultIf(accountID, f, instanceID); err != nil {
			return err
		}
	}
	rels := [][]string{h.layout.DbSocketInstanceRel(accountID, instanceID)}
	if purge {
		rels = append(rels, h.layout.DbDataRel(accountID, instanceID))
	}
	for _, rel := range rels {
		if err := h.removeIfExists(rel); err != nil {
			return err
		}
	}
	return nil
}

// SetDefaultDbSocket points dbsock/<family>/<socket> to the instance socket
// (atomically: link created under a temp name then renamed over the old
// one); instanceID nil removes the link.
func (h *hostOps) SetDefaultDbSocket(ctx context.Context, accountID int64, f DbFamily, instanceID *int64) error {
	if err := validateID("account id", accountID); err != nil {
		return err
	}
	if _, err := parseDbFamily(string(f)); err != nil {
		return err
	}
	if instanceID != nil {
		if err := validateID("instance id", *instanceID); err != nil {
			return err
		}
	}
	unlock, err := h.lock(ctx, accountID, quickLockWait)
	if err != nil {
		return err
	}
	defer unlock()
	dir, err := h.open(h.layout.DbSocketDefaultRel(accountID, f))
	if err != nil {
		return err
	}
	defer dir.Close()
	name := f.SocketName()
	if instanceID == nil {
		return removeLinkOnly(dir, name)
	}
	target := DbSocketLinkTarget(f, *instanceID)
	if cur, err := dir.Readlink(name); err == nil && cur == target {
		return nil
	}
	tmp, err := linkTmpName(name)
	if err != nil {
		return err
	}
	if err := dir.Symlink(target, tmp); err != nil {
		return err
	}
	// rename(2) replaces the old entry atomically (a link or nothing; never a
	// directory: the dir is root-owned, nobody else can create one there).
	if fi, err := dir.Lstat(name); err == nil && fi.IsDir() {
		_ = dir.Remove(tmp)
		return unsafePath("%s/%s is a directory", dir.Name(), name)
	}
	if err := dir.Rename(tmp, name); err != nil {
		_ = dir.Remove(tmp)
		return err
	}
	return nil
}

// unlinkDefaultIf removes the default link of a family when it points to the instance.
func (h *hostOps) unlinkDefaultIf(accountID int64, f DbFamily, instanceID int64) error {
	dir, err := h.open(h.layout.DbSocketDefaultRel(accountID, f))
	var ae *apiError
	if errors.As(err, &ae) && ae.Code == codeNotFound {
		return nil
	}
	if err != nil {
		return err
	}
	defer dir.Close()
	cur, err := dir.Readlink(f.SocketName())
	if err != nil {
		return nil // no link (or not a link): nothing of this instance
	}
	if cur != DbSocketLinkTarget(f, instanceID) {
		return nil
	}
	return removeLinkOnly(dir, f.SocketName())
}

// removeIfExists removes the entry rel (tree or link itself, never followed).
func (h *hostOps) removeIfExists(rel []string) error {
	parent, err := h.open(rel[:len(rel)-1])
	var ae *apiError
	if errors.As(err, &ae) && ae.Code == codeNotFound {
		return nil
	}
	if err != nil {
		return err
	}
	defer parent.Close()
	return removeEntry(parent, rel[len(rel)-1])
}

// removeLinkOnly removes name when it is a symlink (or missing); anything
// else is left alone and reported.
func removeLinkOnly(dir *os.Root, name string) error {
	fi, err := dir.Lstat(name)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if fi.Mode()&fs.ModeSymlink == 0 {
		return unsafePath("%s/%s is not a symbolic link", dir.Name(), name)
	}
	return dir.Remove(name)
}

func linkTmpName(name string) (string, error) {
	var b [6]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return ".oblimint-link-" + hex.EncodeToString(b[:]) + "-" + name, nil
}
