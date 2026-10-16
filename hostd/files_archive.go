package main

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"context"
	"crypto/rand"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path"
	"strings"
	"time"
)

// ─────────────────────────────────────────────────────────────────────────────
// Archives of the web file explorer (files.go rules apply):
//
//   - Extract: a .zip / .tar / .tar.gz / .tgz of the account is unpacked into
//     a directory of the account. Entry names are cleaned and confined (no
//     absolute path, no "..", at most filesMaxDepth levels); links, devices and
//     other special entries are skipped (never created); every directory is
//     entered without following links (a link already in the target makes the
//     entry a conflict); files are created uid:gid 0644, written through a
//     temporary name then renamed; existing files are kept unless overwrite.
//     Bombs: at most archiveMaxEntries entries and archiveMaxBytes written
//     (the account quota stops it earlier anyway).
//   - Zip: selected entries of one directory are streamed as a zip (folders
//     recursively); links and special files are skipped, never followed.
// ─────────────────────────────────────────────────────────────────────────────

const (
	archiveMaxEntries = 200_000
	archiveMaxBytes   = 50 << 30
	extractTmpPrefix  = ".oblimint-extract-"
)

// ExtractResult summarizes an extraction.
type ExtractResult struct {
	Files     int      `json:"files"`
	Dirs      int      `json:"dirs"`
	Bytes     int64    `json:"bytes"`
	Skipped   int      `json:"skipped"`   // links / special entries / existing files kept
	Conflicts []string `json:"conflicts"` // entries blocked by a link or a file in the way (first 100)
}

type archiveEntry struct {
	name  string
	isDir bool
	open  func() (io.ReadCloser, error)
}

// cleanEntryName confines an archive entry name ("" = skip it).
func cleanEntryName(name string) []string {
	name = strings.ReplaceAll(name, `\`, "/")
	var segs []string
	for _, s := range strings.Split(name, "/") {
		switch s {
		case "", ".":
			continue
		case "..":
			return nil
		}
		if len(s) > 255 || strings.ContainsRune(s, 0) {
			return nil
		}
		segs = append(segs, s)
	}
	if len(segs) == 0 || len(segs) > filesMaxDepth {
		return nil
	}
	return segs
}

// Extract unpacks the archive at segs into the directory at to.
func (m *fileManager) Extract(ctx context.Context, accountID int64, segs, to []string, o Owner, overwrite bool) (ExtractResult, error) {
	res := ExtractResult{Conflicts: []string{}}
	if len(to) < 2 {
		return res, forbidden("%s cannot be changed from the explorer", path.Join(to...))
	}
	f, fi, err := m.Open(accountID, segs)
	if err != nil {
		return res, err
	}
	defer f.Close()
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
	walk, err := archiveWalker(segs[len(segs)-1], f, fi.Size())
	if err != nil {
		return res, err
	}
	x := &extractor{m: m, dest: dest, o: o, overwrite: overwrite, res: &res}
	err = walk(func(e archiveEntry) error {
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

// tarWalker iterates over the entries of a tar (gz: gzip-compressed) stream.
func tarWalker(src io.Reader, gz bool) func(func(archiveEntry) error) error {
	return func(fn func(archiveEntry) error) error {
		r := src
		if gz {
			z, err := gzip.NewReader(src)
			if err != nil {
				return badRequest("not a valid gzip archive: %v", err)
			}
			defer z.Close()
			r = z
		}
		tr := tar.NewReader(r)
		for {
			h, err := tr.Next()
			if errors.Is(err, io.EOF) {
				return nil
			}
			if err != nil {
				return badRequest("invalid tar archive: %v", err)
			}
			switch h.Typeflag {
			case tar.TypeDir:
				err = fn(archiveEntry{name: h.Name, isDir: true, open: func() (io.ReadCloser, error) { return nil, nil }})
			case tar.TypeReg:
				err = fn(archiveEntry{name: h.Name, open: func() (io.ReadCloser, error) { return io.NopCloser(tr), nil }})
			default:
				err = fn(archiveEntry{name: h.Name}) // links, devices…: skipped
			}
			if err != nil {
				return err
			}
		}
	}
}

// archiveWalker returns the iteration over the entries of a zip / tar(.gz).
func archiveWalker(name string, f *os.File, size int64) (func(func(archiveEntry) error) error, error) {
	lower := strings.ToLower(name)
	switch {
	case strings.HasSuffix(lower, ".zip"):
		zr, err := zip.NewReader(f, size)
		if err != nil {
			return nil, badRequest("not a valid zip archive: %v", err)
		}
		return func(fn func(archiveEntry) error) error {
			for _, zf := range zr.File {
				mode := zf.Mode()
				if mode&fs.ModeSymlink != 0 || (!mode.IsDir() && !mode.IsRegular()) {
					if err := fn(archiveEntry{name: zf.Name}); err != nil { // skipped (no open)
						return err
					}
					continue
				}
				zf := zf
				if err := fn(archiveEntry{name: zf.Name, isDir: mode.IsDir() || strings.HasSuffix(zf.Name, "/"), open: func() (io.ReadCloser, error) { return zf.Open() }}); err != nil {
					return err
				}
			}
			return nil
		}, nil
	case strings.HasSuffix(lower, ".tar"), strings.HasSuffix(lower, ".tar.gz"), strings.HasSuffix(lower, ".tgz"):
		if strings.HasSuffix(lower, ".tar") {
			return tarWalker(f, false), nil
		}
		return tarWalker(f, true), nil
	default:
		return nil, badRequest("unsupported archive type (zip, tar, tar.gz, tgz)")
	}
}

type extractor struct {
	m         *fileManager
	dest      *os.Root
	o         Owner
	overwrite bool
	res       *ExtractResult
}

func (x *extractor) conflict(name string) {
	x.res.Skipped++
	if len(x.res.Conflicts) < 100 {
		x.res.Conflicts = append(x.res.Conflicts, name)
	}
}

// enter walks (creating as needed) the directories segs below dest.
func (x *extractor) enter(segs []string) (*os.Root, error) {
	cur, err := x.dest.OpenRoot(".")
	if err != nil {
		return nil, err
	}
	for _, s := range segs {
		fi, err := cur.Lstat(s)
		switch {
		case errors.Is(err, fs.ErrNotExist):
			if err := cur.Mkdir(s, filesDirMode); err != nil && !errors.Is(err, fs.ErrExist) {
				cur.Close()
				return nil, err
			}
			next, err := openDir(cur, s)
			cur.Close()
			if err != nil {
				return nil, err
			}
			if err := applyOwner(next, x.o, filesDirMode, x.m.own); err != nil {
				next.Close()
				return nil, err
			}
			x.res.Dirs++
			cur = next
			continue
		case err != nil:
			cur.Close()
			return nil, err
		case !fi.IsDir():
			cur.Close()
			return nil, unsafePath("%s is not a directory", s)
		}
		next, err := openDir(cur, s) // refuses a symlink
		cur.Close()
		if err != nil {
			return nil, err
		}
		cur = next
	}
	return cur, nil
}

func (x *extractor) entry(e archiveEntry) error {
	segs := cleanEntryName(e.name)
	if segs == nil || e.open == nil {
		x.res.Skipped++
		return nil
	}
	if e.isDir {
		d, err := x.enter(segs)
		if err != nil {
			if errors.Is(err, errUnsafePath) {
				x.conflict(e.name)
				return nil
			}
			return err
		}
		return d.Close()
	}
	dir, err := x.enter(segs[:len(segs)-1])
	if err != nil {
		if errors.Is(err, errUnsafePath) {
			x.conflict(e.name)
			return nil
		}
		return err
	}
	defer dir.Close()
	name := segs[len(segs)-1]
	if fi, err := dir.Lstat(name); err == nil {
		if !fi.Mode().IsRegular() {
			x.conflict(e.name)
			return nil
		}
		if !x.overwrite {
			x.res.Skipped++
			return nil
		}
	}
	rc, err := e.open()
	if err != nil {
		return badRequest("%s: %v", e.name, err)
	}
	defer rc.Close()
	tmp := extractTmpPrefix + randomSuffix()
	out, err := dir.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	left := int64(archiveMaxBytes) - x.res.Bytes
	n, err := io.Copy(out, io.LimitReader(rc, left+1))
	if err == nil && n > left {
		err = badRequest("archive expands to more than %d GiB", archiveMaxBytes>>30)
	}
	if err == nil {
		err = x.m.own(out, x.o, filesFileMode)
	}
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = renameAt(dir, tmp, dir, name)
	}
	if err != nil {
		_ = dir.Remove(tmp)
		return err
	}
	x.res.Files++
	x.res.Bytes += n
	return nil
}

func randomSuffix() string {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return time.Now().Format("150405.000000000")
	}
	const hex = "0123456789abcdef"
	out := make([]byte, 16)
	for i, v := range b {
		out[i*2], out[i*2+1] = hex[v>>4], hex[v&15]
	}
	return string(out)
}

// WriteZip streams the entries names of the directory at segs as a zip.
func (m *fileManager) WriteZip(ctx context.Context, accountID int64, segs []string, names []string, w io.Writer) error {
	dir, err := m.openDirPath(accountID, segs)
	if err != nil {
		return err
	}
	defer dir.Close()
	zw := zip.NewWriter(w)
	var total int64
	var add func(parent *os.Root, name, prefix string, depth int) error
	add = func(parent *os.Root, name, prefix string, depth int) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if depth > maxTreeDepth {
			return nil
		}
		fi, err := parent.Lstat(name)
		if err != nil {
			return nil // removed meanwhile
		}
		zpath := prefix + name
		switch {
		case fi.IsDir():
			d, err := openDir(parent, name)
			if err != nil {
				return nil // became a link: skipped
			}
			defer d.Close()
			if _, err := zw.CreateHeader(&zip.FileHeader{Name: zpath + "/", Modified: fi.ModTime(), Method: zip.Store}); err != nil {
				return err
			}
			f, err := d.Open(".")
			if err != nil {
				return err
			}
			children, err := f.Readdirnames(-1)
			f.Close()
			if err != nil {
				return err
			}
			for _, c := range children {
				if isUploadTemp(c) || strings.HasPrefix(c, extractTmpPrefix) {
					continue
				}
				if err := add(d, c, zpath+"/", depth+1); err != nil {
					return err
				}
			}
			return nil
		case fi.Mode().IsRegular():
			f, ok, err := openRegular(parent, name)
			if err != nil || !ok {
				return nil
			}
			defer f.Close()
			h := &zip.FileHeader{Name: zpath, Modified: fi.ModTime(), Method: zip.Deflate}
			h.SetMode(fi.Mode().Perm())
			zf, err := zw.CreateHeader(h)
			if err != nil {
				return err
			}
			n, err := io.Copy(zf, f)
			total += n
			return err
		default:
			return nil // links, special files: never followed
		}
	}
	for _, n := range names {
		if n == "" || n == "." || n == ".." || strings.ContainsAny(n, "/\x00") {
			continue
		}
		if err := add(dir, n, "", 0); err != nil {
			return err
		}
	}
	_ = total
	return zw.Close()
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

func (a *api) extractArchive(w http.ResponseWriter, r *http.Request) {
	id, o, body, segs, err := filesRequest(r, "path", "to")
	var res ExtractResult
	if err == nil {
		res, err = a.files.Extract(r.Context(), id, segs["path"], segs["to"], o, body.Overwrite)
	}
	reply(w, r, res, err)
}

// zipFiles: GET ?path=<dir>&name=a&name=b → application/zip stream.
func (a *api) zipFiles(w http.ResponseWriter, r *http.Request) {
	accountID, err := pathID(r, "id")
	var segs []string
	if err == nil {
		segs, err = splitFilesPath(r.URL.Query().Get("path"))
	}
	names := r.URL.Query()["name"]
	if err == nil && (len(names) == 0 || len(names) > 1000) {
		err = badRequest("1 to 1000 names are required")
	}
	if err == nil {
		// Checked before the first byte: a missing folder is a JSON error, not a broken zip.
		var d *os.Root
		if d, err = a.files.openDirPath(accountID, segs); err == nil {
			d.Close()
		}
	}
	if err != nil {
		writeError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/zip")
	if err := a.files.WriteZip(r.Context(), accountID, segs, names, w); err != nil {
		// Headers are gone: the truncated stream is the error (the panel aborts the download).
		panic(http.ErrAbortHandler)
	}
}
