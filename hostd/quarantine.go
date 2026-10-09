package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"slices"
	"strings"
	"sync"
	"time"
)

// ─────────────────────────────────────────────────────────────────────────────
// Quarantine store (docs/P3-PLAN.md §4, §8, §12; invariant M9): accounts/<a>/
// quarantine/<entryId>/{content,meta.json}, root 0700 / 0600, never mounted in
// any container. hostd MOVES a non-conforming file here (rename on the same
// filesystem, copy + unlink otherwise) and never deletes one: only the staff
// does, through DELETE (audited by the panel). A restore moves the content
// back without following links and allow-lists (path, sha256) so the watchers
// leave it alone.
// ─────────────────────────────────────────────────────────────────────────────

const (
	quarantineContent   = "content"
	quarantineMeta      = "meta.json"
	allowListFile       = "allow.json"
	maxAllowListEntries = 10_000
	maxPreviewBytes     = 256 << 10
)

// quarantineMetaFile is meta.json: the public entry + what a restore needs.
type quarantineMetaFile struct {
	QuarantineEntry
	// FileMode: permission bits of the file when it was quarantined.
	FileMode uint32 `json:"fileMode"`
	// Kind: file | symlink | special.
	Kind string `json:"kind"`
}

// allowEntry is one (area, slug, path, sha256) restored by the staff.
type allowEntry struct {
	Area   string `json:"area"`
	Slug   string `json:"slug"`
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
}

type quarantineStore struct {
	layout Layout
	own    ownerFunc
	lchown lchownFunc
	now    func() time.Time

	mu sync.Mutex // one writer at a time (entries, allow lists)
}

func newQuarantineStore(l Layout, own ownerFunc, lchown lchownFunc, now func() time.Time) *quarantineStore {
	return &quarantineStore{layout: l, own: own, lchown: lchown, now: now}
}

func conflictError(code, format string, args ...any) error {
	return &apiError{http.StatusConflict, code, fmt.Sprintf(format, args...)}
}

// openAccount enters accounts/<a> without following links (404 when missing).
func (q *quarantineStore) openAccount(accountID int64) (*os.Root, error) {
	root, err := os.OpenRoot(q.layout.Root)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	dir, err := openPath(root, q.layout.AccountRel(accountID))
	if errors.Is(err, fs.ErrNotExist) {
		return nil, notFound("account %d does not exist", accountID)
	}
	return dir, err
}

// storeDir enters (create: creates) accounts/<a>/quarantine, root 0700.
func (q *quarantineStore) storeDir(accountID int64, create bool) (*os.Root, error) {
	acct, err := q.openAccount(accountID)
	if err != nil {
		return nil, err
	}
	defer acct.Close()
	if create {
		return ensureDir(acct, "quarantine", rootOwner, 0o700, q.own)
	}
	return openDir(acct, "quarantine")
}

// newEntryID: <utc timestamp>-<8 hex>, e.g. 20261009t031500-1a2b3c4d.
func newEntryID(now time.Time) (string, error) {
	var b [4]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return strings.ToLower(now.UTC().Format("20060102t150405")) + "-" + hex.EncodeToString(b[:]), nil
}

// newEntryDir creates a fresh accounts/<a>/quarantine/<id>/ (root 0700).
func (q *quarantineStore) newEntryDir(store *os.Root) (*os.Root, string, error) {
	for range 5 {
		eid, err := newEntryID(q.now())
		if err != nil {
			return nil, "", err
		}
		if err := store.Mkdir(eid, 0o700); errors.Is(err, fs.ErrExist) {
			continue
		} else if err != nil {
			return nil, "", err
		}
		dir, err := openDir(store, eid)
		if err == nil {
			err = applyOwner(dir, rootOwner, 0o700, q.own)
		}
		if err != nil {
			if dir != nil {
				dir.Close()
			}
			_ = removeEntry(store, eid)
			return nil, "", err
		}
		return dir, eid, nil
	}
	return nil, "", errors.New("quarantine: no free entry id")
}

// moveIn moves name of srcDir into a new entry (the evidence keeps its
// inode: rename), then makes it root 0600 and writes meta.json. e carries the
// descriptive fields; id, size, sha256 and the date are filled here.
func (q *quarantineStore) moveIn(accountID int64, srcDir *os.Root, name string, e QuarantineEntry) (QuarantineEntry, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	fi, err := srcDir.Lstat(name)
	if err != nil {
		return e, err
	}
	store, err := q.storeDir(accountID, true)
	if err != nil {
		return e, err
	}
	defer store.Close()
	dir, eid, err := q.newEntryDir(store)
	if err != nil {
		return e, err
	}
	defer dir.Close()

	// A hard-linked file is copied then unlinked: chowning the shared inode
	// to root would change the other names too.
	_, _, linked := fileUsage(srcDir, name, fi)
	moved := false
	if !linked {
		err = renameAt(srcDir, name, dir, quarantineContent)
		if err == nil {
			moved = true
		} else if !isCrossDevice(err) {
			_ = removeEntry(store, eid)
			return e, err
		}
	}
	if !moved {
		if err := copyEntry(srcDir, name, dir, quarantineContent, fi); err != nil {
			_ = removeEntry(store, eid)
			return e, err
		}
		if err := srcDir.Remove(name); err != nil && !errors.Is(err, fs.ErrNotExist) {
			_ = removeEntry(store, eid)
			return e, err
		}
	}
	return q.seal(store, dir, eid, e, fi)
}

// copyIn stores a copy of content (supervised mode: the file stays to be
// reverted through the merged view).
func (q *quarantineStore) copyIn(accountID int64, content io.Reader, fi fs.FileInfo, e QuarantineEntry) (QuarantineEntry, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	store, err := q.storeDir(accountID, true)
	if err != nil {
		return e, err
	}
	defer store.Close()
	dir, eid, err := q.newEntryDir(store)
	if err != nil {
		return e, err
	}
	defer dir.Close()
	out, err := dir.OpenFile(quarantineContent, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err == nil {
		_, err = io.Copy(out, content)
		if cerr := out.Close(); err == nil {
			err = cerr
		}
	}
	if err != nil {
		_ = removeEntry(store, eid)
		return e, err
	}
	return q.seal(store, dir, eid, e, fi)
}

// copyLinkIn stores a copy of a symlink (never followed).
func (q *quarantineStore) copyLinkIn(accountID int64, srcDir *os.Root, name string, fi fs.FileInfo, e QuarantineEntry) (QuarantineEntry, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	store, err := q.storeDir(accountID, true)
	if err != nil {
		return e, err
	}
	defer store.Close()
	dir, eid, err := q.newEntryDir(store)
	if err != nil {
		return e, err
	}
	defer dir.Close()
	if err := copyEntry(srcDir, name, dir, quarantineContent, fi); err != nil {
		_ = removeEntry(store, eid)
		return e, err
	}
	return q.seal(store, dir, eid, e, fi)
}

// copyEntry copies a regular file or a symlink (never followed) into dst.
func copyEntry(src *os.Root, name string, dst *os.Root, dstName string, fi fs.FileInfo) error {
	switch kindOf(fi) {
	case kindSymlink:
		target, err := src.Readlink(name)
		if err != nil {
			return err
		}
		return dst.Symlink(target, dstName)
	case kindFile:
		in, ok, err := openRegular(src, name)
		if err != nil {
			return err
		}
		if !ok {
			return unsafePath("%s changed during the copy", name)
		}
		defer in.Close()
		out, err := dst.OpenFile(dstName, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if err != nil {
			return err
		}
		_, err = io.Copy(out, in)
		if cerr := out.Close(); err == nil {
			err = cerr
		}
		return err
	}
	// fifo / socket: nothing to keep but the fact (an empty placeholder).
	f, err := dst.OpenFile(dstName, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	return f.Close()
}

// seal makes the content root-only, measures it and writes meta.json.
func (q *quarantineStore) seal(store, dir *os.Root, eid string, e QuarantineEntry, orig fs.FileInfo) (QuarantineEntry, error) {
	fail := func(err error) (QuarantineEntry, error) {
		// The content stays (evidence, M9): only an unreadable entry is left
		// behind, listed without meta (logged by the caller).
		return e, err
	}
	fi, err := dir.Lstat(quarantineContent)
	if err != nil {
		return fail(err)
	}
	kind := "special"
	h := sha256.New()
	var size int64
	switch kindOf(fi) {
	case kindSymlink:
		kind = "symlink"
		target, err := dir.Readlink(quarantineContent)
		if err != nil {
			return fail(err)
		}
		size = int64(len(target))
		h.Write([]byte(target))
		if err := q.lchown(dir, quarantineContent, rootOwner); err != nil {
			return fail(err)
		}
	case kindFile:
		kind = "file"
		f, ok, err := openRegular(dir, quarantineContent)
		if err != nil || !ok {
			if err == nil {
				err = unsafePath("quarantined content changed")
			}
			return fail(err)
		}
		size, err = io.Copy(h, f)
		if err == nil {
			err = q.own(f, rootOwner, 0o600)
		}
		f.Close()
		if err != nil {
			return fail(err)
		}
	default:
		if err := q.lchown(dir, quarantineContent, rootOwner); err != nil {
			return fail(err)
		}
	}
	e.ID = eid
	e.Size = size
	e.SHA256 = hex.EncodeToString(h.Sum(nil))
	e.QuarantinedAt = q.now().UTC().Format(time.RFC3339)
	e.RestoredAt = nil
	meta := quarantineMetaFile{QuarantineEntry: e, FileMode: uint32(orig.Mode().Perm()), Kind: kind}
	if err := writeJSONFile(dir, quarantineMeta, meta); err != nil {
		return fail(err)
	}
	return e, nil
}

// writeJSONFile writes v to name in dir atomically (tmp + rename), root 0600.
func writeJSONFile(dir *os.Root, name string, v any) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	tmp := name + ".tmp"
	_ = dir.Remove(tmp)
	f, err := dir.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	_, err = f.Write(b)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = dir.Rename(tmp, name)
	}
	if err != nil {
		_ = dir.Remove(tmp)
	}
	return err
}

// readJSONFile reads a regular file of dir (never through a link) into v.
func readJSONFile(dir *os.Root, name string, v any) error {
	f, ok, err := openRegular(dir, name)
	if err != nil {
		return err
	}
	if !ok {
		return unsafePath("%s is not a regular file", name)
	}
	defer f.Close()
	return json.NewDecoder(io.LimitReader(f, 4<<20)).Decode(v)
}

func (q *quarantineStore) list(accountID int64) ([]QuarantineEntry, error) {
	store, err := q.storeDir(accountID, false)
	if errors.Is(err, fs.ErrNotExist) {
		return []QuarantineEntry{}, nil
	}
	if err != nil {
		return nil, err
	}
	defer store.Close()
	names, err := readNames(store)
	if err != nil {
		return nil, err
	}
	out := []QuarantineEntry{}
	for _, n := range names {
		if validateQuarantineID(n) != nil {
			continue
		}
		m, err := q.readMeta(store, n)
		if err != nil {
			continue // being written, or damaged: its content is still kept
		}
		out = append(out, m.QuarantineEntry)
	}
	slices.SortFunc(out, func(a, b QuarantineEntry) int { return strings.Compare(a.ID, b.ID) })
	return out, nil
}

func (q *quarantineStore) readMeta(store *os.Root, eid string) (quarantineMetaFile, error) {
	var m quarantineMetaFile
	dir, err := openDir(store, eid)
	if err != nil {
		return m, err
	}
	defer dir.Close()
	if err := readJSONFile(dir, quarantineMeta, &m); err != nil {
		return m, err
	}
	m.ID = eid
	return m, nil
}

// openEntry enters an existing entry (404 when missing).
func (q *quarantineStore) openEntry(accountID int64, eid string) (*os.Root, *os.Root, quarantineMetaFile, error) {
	var m quarantineMetaFile
	if err := validateQuarantineID(eid); err != nil {
		return nil, nil, m, err
	}
	store, err := q.storeDir(accountID, false)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil, m, notFound("quarantine entry %s does not exist", eid)
	}
	if err != nil {
		return nil, nil, m, err
	}
	m, err = q.readMeta(store, eid)
	if errors.Is(err, fs.ErrNotExist) {
		store.Close()
		return nil, nil, m, notFound("quarantine entry %s does not exist", eid)
	}
	if err != nil {
		store.Close()
		return nil, nil, m, err
	}
	dir, err := openDir(store, eid)
	if err != nil {
		store.Close()
		return nil, nil, m, err
	}
	return store, dir, m, nil
}

// remove deletes an entry for good (staff action, audited by the panel).
func (q *quarantineStore) remove(accountID int64, eid string) error {
	if err := validateQuarantineID(eid); err != nil {
		return err
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	store, err := q.storeDir(accountID, false)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer store.Close()
	return removeEntry(store, eid)
}

func (q *quarantineStore) preview(accountID int64, eid string, max int) (Preview, error) {
	store, dir, _, err := q.openEntry(accountID, eid)
	if err != nil {
		return Preview{}, err
	}
	defer store.Close()
	defer dir.Close()
	max = min(max, maxPreviewBytes)
	fi, err := dir.Lstat(quarantineContent)
	if errors.Is(err, fs.ErrNotExist) {
		return Preview{}, notFound("quarantine entry %s has no content (restored)", eid)
	}
	if err != nil {
		return Preview{}, err
	}
	var data []byte
	var size int64
	switch kindOf(fi) {
	case kindSymlink:
		target, err := dir.Readlink(quarantineContent)
		if err != nil {
			return Preview{}, err
		}
		data, size = []byte(target), int64(len(target))
	case kindFile:
		f, ok, err := openRegular(dir, quarantineContent)
		if err != nil || !ok {
			return Preview{}, err
		}
		defer f.Close()
		data, err = io.ReadAll(io.LimitReader(f, int64(max)+1))
		if err != nil {
			return Preview{}, err
		}
		size = fi.Size()
	}
	truncated := len(data) > max
	if truncated {
		data = data[:max]
	}
	return Preview{Base64: base64.StdEncoding.EncodeToString(data), Truncated: truncated || size > int64(len(data)), Size: size}, nil
}

// restoreTarget is where a restore writes: the directory the entry's path is
// relative to (data/<slug>, or the merged view of the window for area code),
// the owner of the restored file and the mode of the directories it creates.
type restoreTarget struct {
	root    *os.Root
	dirMode fs.FileMode
}

// restore moves the content back to target/<path> as owner. overwrite=false
// refuses an existing entry (409 restoreConflict).
func (q *quarantineStore) restore(accountID int64, eid string, owner Owner, overwrite bool, target func(m quarantineMetaFile) (restoreTarget, error)) (RestoreResult, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	store, dir, m, err := q.openEntry(accountID, eid)
	if err != nil {
		return RestoreResult{}, err
	}
	defer store.Close()
	defer dir.Close()
	cfi, err := dir.Lstat(quarantineContent)
	if errors.Is(err, fs.ErrNotExist) || m.RestoredAt != nil {
		return RestoreResult{}, conflictError(codeConflict, "quarantine entry %s was already restored", eid)
	}
	if err != nil {
		return RestoreResult{}, err
	}
	segs, ok := splitRelPath(m.Path)
	if !ok {
		return RestoreResult{}, badRequest("quarantine entry %s has an invalid path", eid)
	}
	t, err := target(m)
	if err != nil {
		return RestoreResult{}, err
	}
	defer t.root.Close()
	// Parents entered without following links, missing ones created as
	// owner (existing ones are left as they are).
	walker := &stagingApplier{owner: owner, dirMode: t.dirMode, own: q.own}
	parent, err := walker.enterParents(t.root, segs[:len(segs)-1], true)
	if r := conflictOf(err); r != "" {
		return RestoreResult{}, unsafePath("%s: a parent is a %s", m.Path, r)
	}
	if err != nil {
		return RestoreResult{}, err
	}
	defer parent.Close()
	leaf := segs[len(segs)-1]
	if efi, err := parent.Lstat(leaf); err == nil {
		if !overwrite || efi.IsDir() {
			return RestoreResult{}, conflictError(codeRestoreConflict, "%s already exists", m.Path)
		}
		if err := parent.Remove(leaf); err != nil {
			return RestoreResult{}, err
		}
	} else if !errors.Is(err, fs.ErrNotExist) {
		return RestoreResult{}, err
	}

	// Allow-listed BEFORE the file reappears: the watchers must not take it
	// back between the move and the update of allow.json.
	slug := ""
	if m.Slug != nil {
		slug = *m.Slug
	}
	if err := q.allow(store, allowEntry{Area: m.Area, Slug: slug, Path: m.Path, SHA256: m.SHA256}); err != nil {
		return RestoreResult{}, err
	}
	moved := false
	if err := renameAt(dir, quarantineContent, parent, leaf); err == nil {
		moved = true
	} else if !isCrossDevice(err) {
		return RestoreResult{}, err
	}
	if !moved { // the merged view of a window is another filesystem
		if err := copyEntry(dir, quarantineContent, parent, leaf, cfi); err != nil {
			_ = parent.Remove(leaf)
			return RestoreResult{}, err
		}
		if err := dir.Remove(quarantineContent); err != nil {
			return RestoreResult{}, err
		}
	}
	if err := q.restoreOwner(parent, leaf, owner, m); err != nil {
		return RestoreResult{}, err
	}
	now := q.now().UTC().Format(time.RFC3339)
	m.RestoredAt = &now
	if err := writeJSONFile(dir, quarantineMeta, m); err != nil {
		return RestoreResult{}, err
	}
	return RestoreResult{Restored: true, Path: m.Path}, nil
}

func (q *quarantineStore) restoreOwner(parent *os.Root, leaf string, owner Owner, m quarantineMetaFile) error {
	if m.Kind != "file" {
		return q.lchown(parent, leaf, owner)
	}
	f, ok, err := openRegular(parent, leaf)
	if err != nil {
		return err
	}
	if !ok {
		return unsafePath("%s changed during the restore", m.Path)
	}
	defer f.Close()
	mode := fs.FileMode(m.FileMode).Perm() &^ 0o022 // never group / world writable
	if mode == 0 {
		mode = 0o644
	}
	return q.own(f, owner, mode)
}

// allow adds e to allow.json (bounded: the oldest entries go first).
func (q *quarantineStore) allow(store *os.Root, e allowEntry) error {
	list := q.readAllow(store)
	if slices.Contains(list, e) {
		return nil
	}
	list = append(list, e)
	if len(list) > maxAllowListEntries {
		list = list[len(list)-maxAllowListEntries:]
	}
	return writeJSONFile(store, allowListFile, list)
}

func (q *quarantineStore) readAllow(store *os.Root) []allowEntry {
	var list []allowEntry
	if err := readJSONFile(store, allowListFile, &list); err != nil {
		return nil
	}
	return list
}

// allowed reports whether (area, slug, path, sha256) was restored by the staff.
func (q *quarantineStore) allowed(accountID int64, e allowEntry) bool {
	store, err := q.storeDir(accountID, false)
	if err != nil {
		return false
	}
	defer store.Close()
	return slices.Contains(q.readAllow(store), e)
}
