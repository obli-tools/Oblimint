package main

import (
	"archive/tar"
	"context"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path"
	"strconv"
	"strings"
)

// ─────────────────────────────────────────────────────────────────────────────
// Backups of an account's files (panel backups module):
//
//   - WriteTar streams a tar of whole trees of the account (staging/, data/):
//     every directory entered without following links (openDir), symlinks
//     STORED as links (their target text, never followed), special files
//     skipped, our temporaries skipped. Names are relative to the account
//     ("staging/blog/index.php").
//   - Untar restores such a tar into a directory of the account with the
//     extractor rules (files.go / files_archive.go): confined names, links
//     never created, owned uid:gid, existing files kept unless overwrite;
//     clear empties the directory first (full restore of a site's code).
// ─────────────────────────────────────────────────────────────────────────────

// WriteTar writes the trees roots (account-relative paths) to w as a tar.
// relative (one root only): names are relative to that root ("index.php"),
// the form Untar restores into the same directory.
func (m *fileManager) WriteTar(ctx context.Context, accountID int64, roots [][]string, relative bool, w io.Writer) error {
	if relative && len(roots) != 1 {
		return badRequest("a relative tar takes exactly one path")
	}
	tw := tar.NewWriter(w)
	var add func(dir *os.Root, name, prefix string, depth int) error
	add = func(dir *os.Root, name, prefix string, depth int) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if depth > maxTreeDepth {
			return nil
		}
		fi, err := dir.Lstat(name)
		if err != nil {
			return nil // removed meanwhile
		}
		full := path.Join(prefix, name)
		switch {
		case fi.Mode()&fs.ModeSymlink != 0:
			target, err := dir.Readlink(name)
			if err != nil {
				return nil
			}
			return tw.WriteHeader(&tar.Header{Typeflag: tar.TypeSymlink, Name: full, Linkname: target, Mode: 0o777, ModTime: fi.ModTime()})
		case fi.IsDir():
			sub, err := openDir(dir, name)
			if err != nil {
				return nil // became a link meanwhile: skipped
			}
			defer sub.Close()
			if err := tw.WriteHeader(&tar.Header{Typeflag: tar.TypeDir, Name: full + "/", Mode: int64(fi.Mode().Perm()), ModTime: fi.ModTime()}); err != nil {
				return err
			}
			return addChildren(sub, full, depth+1, add)
		case fi.Mode().IsRegular():
			f, ok, err := openRegular(dir, name)
			if err != nil || !ok {
				return nil
			}
			defer f.Close()
			st, err := f.Stat()
			if err != nil {
				return nil
			}
			if err := tw.WriteHeader(&tar.Header{Typeflag: tar.TypeReg, Name: full, Size: st.Size(), Mode: int64(st.Mode().Perm()), ModTime: st.ModTime()}); err != nil {
				return err
			}
			// The header carries the size: a file that grows meanwhile is cut, one that shrinks is padded.
			n, err := io.Copy(tw, io.LimitReader(f, st.Size()))
			if err == nil && n < st.Size() {
				_, err = io.CopyN(tw, zeroReader{}, st.Size()-n)
			}
			return err
		default:
			return nil // sockets, devices, fifos
		}
	}
	for _, segs := range roots {
		root, err := m.openDirPath(accountID, segs)
		if err != nil {
			if isNotFound(err) {
				continue
			}
			return err
		}
		prefix := path.Join(segs...)
		if relative {
			prefix = ""
		} else {
			err = tw.WriteHeader(&tar.Header{Typeflag: tar.TypeDir, Name: prefix + "/", Mode: 0o750})
		}
		if err == nil {
			err = addChildren(root, prefix, 1, add)
		}
		root.Close()
		if err != nil {
			return err
		}
	}
	return tw.Close()
}

func addChildren(dir *os.Root, prefix string, depth int, add func(*os.Root, string, string, int) error) error {
	f, err := dir.Open(".")
	if err != nil {
		return err
	}
	names, err := f.Readdirnames(-1)
	f.Close()
	if err != nil {
		return err
	}
	for _, n := range names {
		if isUploadTemp(n) || strings.HasPrefix(n, extractTmpPrefix) {
			continue
		}
		if err := add(dir, n, prefix, depth); err != nil {
			return err
		}
	}
	return nil
}

type zeroReader struct{}

func (zeroReader) Read(p []byte) (int, error) {
	for i := range p {
		p[i] = 0
	}
	return len(p), nil
}

// Untar restores a tar stream (entry names relative to `to`) into the directory to.
func (m *fileManager) Untar(ctx context.Context, accountID int64, to []string, o Owner, overwrite, clear bool, r io.Reader) (ExtractResult, error) {
	res := ExtractResult{Conflicts: []string{}}
	if len(to) < 2 {
		return res, forbidden("%s cannot be changed from the explorer", path.Join(to...))
	}
	dest, err := m.openDirPath(accountID, to)
	if err != nil {
		return res, err
	}
	defer dest.Close()
	dfi, err := dest.Stat(".")
	if err != nil {
		return res, err
	}
	if ownerOf(dfi).UID != o.UID {
		return res, forbidden("%s is not writable by the account", path.Join(to...))
	}
	if clear {
		if err := clearDir(ctx, dest); err != nil {
			return res, err
		}
	}
	x := &extractor{m: m, dest: dest, o: o, overwrite: overwrite || clear, res: &res}
	err = tarWalker(r, false)(func(e archiveEntry) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if res.Files+res.Dirs+res.Skipped >= archiveMaxEntries {
			return badRequest("archive has more than %d entries", archiveMaxEntries)
		}
		return x.entry(e)
	})
	return res, diskError(err)
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

// tarFiles: GET ?path=staging&path=data[&relative=1] → application/x-tar stream.
func (a *api) tarFiles(w http.ResponseWriter, r *http.Request) {
	accountID, err := pathID(r, "id")
	raw := r.URL.Query()["path"]
	if err == nil && (len(raw) == 0 || len(raw) > 16) {
		err = badRequest("1 to 16 paths are required")
	}
	var roots [][]string
	for _, p := range raw {
		if err != nil {
			break
		}
		var segs []string
		segs, err = splitFilesPath(p)
		roots = append(roots, segs)
	}
	var relative bool
	if err == nil {
		relative, err = queryBool(r, "relative")
	}
	if err == nil && relative && len(roots) != 1 {
		err = badRequest("a relative tar takes exactly one path")
	}
	if err != nil {
		writeError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/x-tar")
	if err := a.files.WriteTar(r.Context(), accountID, roots, relative, w); err != nil {
		panic(http.ErrAbortHandler) // headers gone: the truncated stream is the error
	}
}

// untarFiles: PUT ?path=<dir>&uid=&gid=&overwrite=1&clear=1, body = tar stream → ExtractResult.
func (a *api) untarFiles(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	accountID, err := pathID(r, "id")
	var segs []string
	if err == nil {
		segs, err = splitFilesPath(q.Get("path"))
	}
	var o Owner
	if err == nil {
		uid, e1 := strconv.Atoi(q.Get("uid"))
		gid, e2 := strconv.Atoi(q.Get("gid"))
		if e1 != nil || e2 != nil {
			err = badRequest("uid and gid are required")
		} else {
			o = Owner{uid, gid}
			err = validateOwner(o)
		}
	}
	var overwrite, clear bool
	if err == nil {
		overwrite, err = queryBool(r, "overwrite")
	}
	if err == nil {
		clear, err = queryBool(r, "clear")
	}
	if err != nil {
		writeError(w, err)
		return
	}
	res, err := a.files.Untar(r.Context(), accountID, segs, o, overwrite, clear, r.Body)
	reply(w, r, res, err)
}
