package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

// ─────────────────────────────────────────────────────────────────────────────
// Web file explorer of an account (panel « Fichiers »): the same tree as the
// account's SFTP server, accounts/<id>/{staging,data}/…, addressed by a path
// relative to the account directory ("staging/<slug>/a/b").
//
//   - every component is entered with openDir (never through a link, R1);
//     symlinks are listed (with their target) but never followed;
//   - a change (mkdir, delete, move, copy, upload) only happens in a directory
//     OWNED by the account's uid, and never on the first two levels
//     (staging/<slug>, data/<slug>): the explorer can do exactly what the
//     account's SFTP user can (data/<slug> is root:gid, only the declared
//     data paths are the account's), never more;
//   - created entries are owned uid:gid (fchown / fchmod on the descriptor);
//   - uploads are written in chunks (in any order, in parallel) into a
//     temporary file next to the target (.oblimint-upload-<id>, uid 0600: in
//     the account's quota), renamed onto the target at commit; temporaries
//     left behind for a day are removed by the next listing of their folder.
// ─────────────────────────────────────────────────────────────────────────────

const (
	filesMaxEntries  = 20_000
	filesMaxDepth    = 64
	filesMaxPathLen  = 4096
	filesDirMode     = 0o755
	filesFileMode    = 0o644
	uploadTmpPrefix  = ".oblimint-upload-"
	uploadStaleAfter = 24 * time.Hour
	maxChunkBytes    = 64 << 20
	maxUploadBytes   = 1 << 42 // 4 TiB: sanity bound, the quota is the real limit
)

const (
	codeForbidden     = "forbidden"     // 403: not the account's directory (SFTP would refuse too)
	codeExists        = "exists"        // 409: the target already exists
	codeNotRegular    = "notRegular"    // 409: not a regular file (directory, link, device…)
	codeQuotaExceeded = "quotaExceeded" // 507: disk quota or space exhausted
)

var uploadIDRe = regexp.MustCompile(`^[0-9a-f]{32}$`)

// FileEntry is one entry of a listing (never followed: a link is a link).
type FileEntry struct {
	Name   string `json:"name"`
	Kind   string `json:"kind"` // file | dir | symlink | other
	Size   int64  `json:"size"`
	MTime  int64  `json:"mtime"` // milliseconds since the epoch
	Mode   uint32 `json:"mode"`  // permission bits
	UID    int    `json:"uid"`
	Target string `json:"target,omitempty"` // symlink target (text, never resolved)
}

// FileListing is the content of one directory.
type FileListing struct {
	Path      string      `json:"path"`
	UID       int         `json:"uid"` // owner of the directory (writable when = the account's)
	Entries   []FileEntry `json:"entries"`
	Truncated bool        `json:"truncated"`
}

type fileManager struct {
	layout Layout
	own    ownerFunc
	now    func() time.Time
}

func newFileManager(l Layout, own ownerFunc, now func() time.Time) *fileManager {
	if resolved, err := filepath.EvalSymlinks(filepath.FromSlash(l.Root)); err == nil {
		l = newLayout(filepath.ToSlash(resolved))
	}
	return &fileManager{layout: l, own: own, now: now}
}

func forbidden(format string, args ...any) error {
	return &apiError{http.StatusForbidden, codeForbidden, fmt.Sprintf(format, args...)}
}

func alreadyExists(format string, args ...any) error {
	return &apiError{http.StatusConflict, codeExists, fmt.Sprintf(format, args...)}
}

// splitFilesPath validates a path relative to the account directory: below
// staging/ or data/, no empty / dot component, at most filesMaxDepth levels.
func splitFilesPath(p string) ([]string, error) {
	if len(p) > filesMaxPathLen || !utf8.ValidString(p) || strings.ContainsRune(p, 0) {
		return nil, badRequest("invalid path")
	}
	p = strings.Trim(p, "/")
	if p == "" {
		return nil, badRequest("path is required")
	}
	segs := strings.Split(p, "/")
	if len(segs) > filesMaxDepth {
		return nil, badRequest("path deeper than %d levels", filesMaxDepth)
	}
	for _, s := range segs {
		if s == "" || s == "." || s == ".." || len(s) > 255 {
			return nil, badRequest("invalid path component %q", s)
		}
	}
	if segs[0] != "staging" && segs[0] != "data" {
		return nil, badRequest("path must be under staging/ or data/")
	}
	return segs, nil
}

func mutableEntry(segs []string) error {
	if len(segs) < 3 {
		return forbidden("%s cannot be changed from the explorer", path.Join(segs...))
	}
	return nil
}

// isUploadTemp: our temporary upload files (never listed).
func isUploadTemp(name string) bool {
	return strings.HasPrefix(name, uploadTmpPrefix) && uploadIDRe.MatchString(name[len(uploadTmpPrefix):])
}

// openDirPath enters accounts/<id>/<segs…> without following links.
func (m *fileManager) openDirPath(accountID int64, segs []string) (*os.Root, error) {
	root, err := os.OpenRoot(m.layout.Root)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	dir, err := openPath(root, append(m.layout.AccountRel(accountID), segs...))
	if errors.Is(err, fs.ErrNotExist) {
		return nil, notFound("%s does not exist", path.Join(segs...))
	}
	return dir, err
}

// openParent opens the parent of a changed entry and checks it is the
// account's (owner uid) and deep enough.
func (m *fileManager) openParent(accountID int64, segs []string, o Owner) (*os.Root, string, error) {
	if err := mutableEntry(segs); err != nil {
		return nil, "", err
	}
	dir, err := m.openDirPath(accountID, segs[:len(segs)-1])
	if err != nil {
		return nil, "", err
	}
	fi, err := dir.Stat(".")
	if err != nil {
		dir.Close()
		return nil, "", err
	}
	if ownerOf(fi).UID != o.UID {
		dir.Close()
		return nil, "", forbidden("%s is not writable by the account", path.Join(segs[:len(segs)-1]...))
	}
	return dir, segs[len(segs)-1], nil
}

func entryKind(fi fs.FileInfo) string {
	switch t := fi.Mode().Type(); {
	case t == 0:
		return "file"
	case t == fs.ModeDir:
		return "dir"
	case t&fs.ModeSymlink != 0:
		return "symlink"
	default:
		return "other"
	}
}

// List returns the entries of a directory (sorted by name, at most filesMaxEntries).
func (m *fileManager) List(ctx context.Context, accountID int64, segs []string) (FileListing, error) {
	dir, err := m.openDirPath(accountID, segs)
	if err != nil {
		return FileListing{}, err
	}
	defer dir.Close()
	dfi, err := dir.Stat(".")
	if err != nil {
		return FileListing{}, err
	}
	f, err := dir.Open(".")
	if err != nil {
		return FileListing{}, err
	}
	var names []string
	truncated := false
	for {
		batch, err := f.Readdirnames(1024)
		names = append(names, batch...)
		if errors.Is(err, io.EOF) || (err == nil && len(batch) == 0) {
			break
		}
		if err != nil {
			f.Close()
			return FileListing{}, err
		}
		if len(names) > filesMaxEntries {
			truncated = true
			break
		}
		if err := ctx.Err(); err != nil {
			f.Close()
			return FileListing{}, err
		}
	}
	f.Close()
	sort.Strings(names)
	out := FileListing{Path: path.Join(segs...), UID: ownerOf(dfi).UID, Entries: make([]FileEntry, 0, len(names))}
	now := m.now()
	for _, name := range names {
		fi, err := dir.Lstat(name)
		if err != nil {
			continue // removed meanwhile
		}
		if isUploadTemp(name) {
			if fi.Mode().IsRegular() && now.Sub(fi.ModTime()) > uploadStaleAfter {
				_ = dir.Remove(name)
			}
			continue
		}
		if len(out.Entries) == filesMaxEntries {
			truncated = true
			break
		}
		e := FileEntry{Name: name, Kind: entryKind(fi), Size: fi.Size(), MTime: fi.ModTime().UnixMilli(),
			Mode: uint32(fi.Mode().Perm()), UID: ownerOf(fi).UID}
		if e.Kind == "symlink" {
			if t, err := dir.Readlink(name); err == nil {
				e.Target = t
			}
		}
		if e.Kind != "file" {
			e.Size = 0
		}
		out.Entries = append(out.Entries, e)
	}
	out.Truncated = truncated
	return out, nil
}

// Open opens a regular file for reading (the caller closes it).
func (m *fileManager) Open(accountID int64, segs []string) (*os.File, fs.FileInfo, error) {
	if len(segs) < 2 {
		return nil, nil, &apiError{http.StatusConflict, codeNotRegular, path.Join(segs...) + " is not a file"}
	}
	dir, err := m.openDirPath(accountID, segs[:len(segs)-1])
	if err != nil {
		return nil, nil, err
	}
	defer dir.Close()
	name := segs[len(segs)-1]
	f, ok, err := openRegular(dir, name)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil, notFound("%s does not exist", path.Join(segs...))
	}
	if err != nil {
		return nil, nil, err
	}
	if !ok {
		return nil, nil, &apiError{http.StatusConflict, codeNotRegular, path.Join(segs...) + " is not a regular file"}
	}
	fi, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, nil, err
	}
	return f, fi, nil
}

// Mkdir creates one directory (its parent must exist).
func (m *fileManager) Mkdir(accountID int64, segs []string, o Owner) error {
	parent, name, err := m.openParent(accountID, segs, o)
	if err != nil {
		return err
	}
	defer parent.Close()
	if err := parent.Mkdir(name, filesDirMode); err != nil {
		if errors.Is(err, fs.ErrExist) {
			return alreadyExists("%s already exists", path.Join(segs...))
		}
		return diskError(err)
	}
	d, err := openDir(parent, name)
	if err != nil {
		return err
	}
	defer d.Close()
	return applyOwner(d, o, filesDirMode, m.own)
}

// Delete removes a file, a link (never its target) or a whole directory tree.
func (m *fileManager) Delete(accountID int64, segs []string, o Owner) error {
	parent, name, err := m.openParent(accountID, segs, o)
	if err != nil {
		return err
	}
	defer parent.Close()
	if _, err := parent.Lstat(name); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return notFound("%s does not exist", path.Join(segs...))
		}
		return err
	}
	return removeEntry(parent, name)
}

// checkTarget: what may happen to an existing target of a move / commit.
func checkTarget(dir *os.Root, name string, srcIsDir, overwrite bool, display string) error {
	fi, err := dir.Lstat(name)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if !overwrite {
		return alreadyExists("%s already exists", display)
	}
	if srcIsDir || fi.IsDir() {
		return alreadyExists("%s already exists (a directory is never replaced)", display)
	}
	return nil
}

func hasPrefixPath(p, prefix []string) bool {
	if len(p) < len(prefix) {
		return false
	}
	for i := range prefix {
		if p[i] != prefix[i] {
			return false
		}
	}
	return true
}

// Move renames from → to (both inside the account, both parents the account's).
func (m *fileManager) Move(accountID int64, from, to []string, o Owner, overwrite bool) error {
	if hasPrefixPath(to, from) {
		return badRequest("cannot move %s into itself", path.Join(from...))
	}
	sp, sname, err := m.openParent(accountID, from, o)
	if err != nil {
		return err
	}
	defer sp.Close()
	dp, dname, err := m.openParent(accountID, to, o)
	if err != nil {
		return err
	}
	defer dp.Close()
	sfi, err := sp.Lstat(sname)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return notFound("%s does not exist", path.Join(from...))
		}
		return err
	}
	if err := checkTarget(dp, dname, sfi.IsDir(), overwrite, path.Join(to...)); err != nil {
		return err
	}
	return diskError(renameAt(sp, sname, dp, dname))
}

// Copy duplicates a file or a directory tree (links and special files are
// skipped inside a tree) to a new name.
func (m *fileManager) Copy(ctx context.Context, accountID int64, from, to []string, o Owner) error {
	if hasPrefixPath(to, from) {
		return badRequest("cannot copy %s into itself", path.Join(from...))
	}
	src, err := m.openDirPath(accountID, from[:len(from)-1])
	if err != nil {
		return err
	}
	defer src.Close()
	sname := from[len(from)-1]
	dp, dname, err := m.openParent(accountID, to, o)
	if err != nil {
		return err
	}
	defer dp.Close()
	sfi, err := src.Lstat(sname)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return notFound("%s does not exist", path.Join(from...))
		}
		return err
	}
	if err := checkTarget(dp, dname, false, false, path.Join(to...)); err != nil {
		return err
	}
	switch entryKind(sfi) {
	case "file":
		return diskError(copyFileAs(src, sname, dp, dname, o, m.own))
	case "dir":
		s, err := openDir(src, sname)
		if err != nil {
			return err
		}
		defer s.Close()
		if err := dp.Mkdir(dname, filesDirMode); err != nil {
			return diskError(err)
		}
		t, err := openDir(dp, dname)
		if err != nil {
			return err
		}
		defer t.Close()
		if err := applyOwner(t, o, filesDirMode, m.own); err != nil {
			return err
		}
		_, err = copyTree(ctx, s, t, o, m.own, 0)
		return diskError(err)
	default:
		return &apiError{http.StatusConflict, codeNotRegular, path.Join(from...) + " cannot be copied (link or special file)"}
	}
}

func copyFileAs(src *os.Root, sname string, dst *os.Root, dname string, o Owner, own ownerFunc) error {
	in, ok, err := openRegular(src, sname)
	if err != nil {
		return err
	}
	if !ok {
		return &apiError{http.StatusConflict, codeNotRegular, sname + " is not a regular file"}
	}
	defer in.Close()
	out, err := dst.OpenFile(dname, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		if errors.Is(err, fs.ErrExist) {
			return alreadyExists("%s already exists", dname)
		}
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		_ = dst.Remove(dname)
		return err
	}
	if err := own(out, o, filesFileMode); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

// ── Chunked uploads ──────────────────────────────────────────────────────────

func validUploadID(id string) error {
	if !uploadIDRe.MatchString(id) {
		return badRequest("invalid upload id")
	}
	return nil
}

// openTemp opens our temporary file for writing: it must still be a regular
// file of the account with a single link (a swap by the tenant is refused).
func openTemp(dir *os.Root, name string, o Owner) (*os.File, error) {
	fi, err := dir.Lstat(name)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, notFound("upload not started or expired")
		}
		return nil, err
	}
	if !fi.Mode().IsRegular() {
		return nil, unsafePath("%s is not a regular file", name)
	}
	f, err := dir.OpenFile(name, os.O_WRONLY|openNoFollowFlags, 0)
	if err != nil {
		return nil, err
	}
	ffi, err := f.Stat()
	if err == nil && (!ffi.Mode().IsRegular() || !os.SameFile(fi, ffi) || ownerOf(ffi).UID != o.UID || linkCount(ffi) > 1) {
		err = unsafePath("%s changed during the upload", name)
	}
	if err != nil {
		f.Close()
		return nil, err
	}
	return f, nil
}

// UploadBegin creates (or keeps) the temporary file of an upload, sized.
// The target must not exist (overwrite: a file may, never a directory).
func (m *fileManager) UploadBegin(accountID int64, segs []string, o Owner, uploadID string, size int64, overwrite bool) error {
	if err := validUploadID(uploadID); err != nil {
		return err
	}
	if size < 0 || size > maxUploadBytes {
		return badRequest("invalid size")
	}
	parent, name, err := m.openParent(accountID, segs, o)
	if err != nil {
		return err
	}
	defer parent.Close()
	// Checked again at commit; here so that nothing is sent for nothing.
	if err := checkTarget(parent, name, false, overwrite, path.Join(segs...)); err != nil {
		return err
	}
	tmp := uploadTmpPrefix + uploadID
	f, err := parent.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if errors.Is(err, fs.ErrExist) {
		f, err = openTemp(parent, tmp, o) // begin replayed: keep what was received
		if err == nil {
			f.Close()
		}
		return err
	}
	if err != nil {
		return diskError(err)
	}
	defer f.Close()
	if err := m.own(f, o, 0o600); err != nil {
		_ = parent.Remove(tmp)
		return err
	}
	if err := f.Truncate(size); err != nil {
		_ = parent.Remove(tmp)
		return diskError(err)
	}
	return nil
}

// UploadChunk writes length bytes of body at offset into the temporary file.
func (m *fileManager) UploadChunk(accountID int64, segs []string, o Owner, uploadID string, offset, length int64, body io.Reader) error {
	if err := validUploadID(uploadID); err != nil {
		return err
	}
	if offset < 0 || length < 0 || length > maxChunkBytes || offset > maxUploadBytes {
		return badRequest("invalid chunk range")
	}
	parent, _, err := m.openParent(accountID, segs, o)
	if err != nil {
		return err
	}
	defer parent.Close()
	f, err := openTemp(parent, uploadTmpPrefix+uploadID, o)
	if err != nil {
		return err
	}
	n, err := io.Copy(io.NewOffsetWriter(f, offset), io.LimitReader(body, length))
	if err == nil && n != length {
		err = badRequest("short chunk: %d of %d bytes", n, length)
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	return diskError(err)
}

// UploadCommit checks the size and renames the temporary file onto the target.
func (m *fileManager) UploadCommit(accountID int64, segs []string, o Owner, uploadID string, size int64, overwrite bool) error {
	if err := validUploadID(uploadID); err != nil {
		return err
	}
	parent, name, err := m.openParent(accountID, segs, o)
	if err != nil {
		return err
	}
	defer parent.Close()
	tmp := uploadTmpPrefix + uploadID
	f, err := openTemp(parent, tmp, o)
	if err != nil {
		return err
	}
	fi, err := f.Stat()
	if err == nil && fi.Size() != size {
		err = badRequest("size mismatch: %d bytes received, %d expected", fi.Size(), size)
	}
	if err == nil {
		err = m.own(f, o, filesFileMode)
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return err
	}
	if err := checkTarget(parent, name, false, overwrite, path.Join(segs...)); err != nil {
		return err
	}
	return diskError(renameAt(parent, tmp, parent, name))
}

// UploadAbort removes the temporary file (absent: nothing to do).
func (m *fileManager) UploadAbort(accountID int64, segs []string, o Owner, uploadID string) error {
	if err := validUploadID(uploadID); err != nil {
		return err
	}
	parent, _, err := m.openParent(accountID, segs, o)
	if err != nil {
		if isNotFound(err) {
			return nil
		}
		return err
	}
	defer parent.Close()
	tmp := uploadTmpPrefix + uploadID
	if fi, err := parent.Lstat(tmp); err == nil && !fi.IsDir() {
		return parent.Remove(tmp)
	}
	return nil
}

// diskError maps "no space" / "quota exceeded" to codeQuotaExceeded.
func diskError(err error) error {
	if err != nil && isNoSpace(err) {
		return &apiError{http.StatusInsufficientStorage, codeQuotaExceeded, "disk quota exceeded"}
	}
	return err
}
