package main

// Release symlinks that reach /srv/data — discovered at render time.
//
// The releases module keeps the release symlinks whose target is a persistent /
// ephemeral data path (Laravel `public/storage -> ../storage/app/public`, with
// `storage` a data path). Apache matches <Directory> against the UNRESOLVED
// path: /srv/releases/current/public/storage/... only matches
// <Directory /srv/releases> (AllowOverride All), so a .htaccess written by PHP
// in /srv/data/storage/app/public/ would be honoured (rewrites, SetEnv →
// FastCGI params, Options +Indexes…). Same for a release file `.htaccess`
// that is itself a link into /srv/data.
//
// siteconf runs inside the site container, after every release switch
// (oblimint-reload), with the release mounted read-only: it walks the served
// tree, resolves every symlink in the CONTAINER namespace and reports the ones
// whose real path is under /srv/data. Render emits for each of them the same
// "data is never interpreted" block as for a data path (AllowOverride None,
// SetHandler None, PHP deny, typed whitelist). Being computed from the tree
// actually served, the list can never be out of date with the release.
//
// Dangling links are resolved lexically: a link to a /srv/data directory that
// does not exist YET is still reported (PHP may create the target later,
// without any reload).

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
)

// DataLink: a place of the current release where /srv/data content is reached.
type DataLink struct {
	// Dir: directory relative to /srv/releases/current ("" = the release root)
	// whose content is (or whose .htaccess is) data. Raw on-disk name: it may
	// contain any byte (render turns unsafe bytes into wildcards).
	Dir string
	// DataRel: the real target relative to /srv/data ("" = /srv/data itself).
	DataRel string
	// HtaccessOnly: Dir is a release directory whose `.htaccess` is a link into
	// /srv/data (only the overrides must be disabled there).
	HtaccessOnly bool
}

const (
	// Walk bounds (a release is a site tree: generous, but never unbounded).
	maxWalkEntries = 1_000_000
	maxDataLinks   = 1024
	maxLinkHops    = 40
	// Directory links INSIDE the release are followed this deep (cycles are cut
	// by the visited set; this only bounds the alias paths).
	maxFollowDepth = 8
	accessFileName = ".htaccess"
)

type nodeKind int

const (
	kindOther nodeKind = iota
	kindDir
	kindLink
)

type dirent struct {
	name string
	kind nodeKind
}

// fsOps: the few read-only operations the walk needs, on CONTAINER paths
// (injectable: symlinks cannot be created on every test machine).
type fsOps interface {
	lstat(c string) (nodeKind, error)
	readlink(c string) (string, error)
	readDir(c string) ([]dirent, error)
}

// osOps: the real filesystem, container paths under an optional host prefix.
type osOps struct{ root string }

func (o osOps) host(c string) string {
	if o.root == "" {
		return filepath.FromSlash(c)
	}
	return filepath.Join(o.root, filepath.FromSlash(c))
}

func kindOf(m fs.FileMode) nodeKind {
	switch {
	case m&fs.ModeSymlink != 0:
		return kindLink
	case m.IsDir():
		return kindDir
	}
	return kindOther
}

func (o osOps) lstat(c string) (nodeKind, error) {
	fi, err := os.Lstat(o.host(c))
	if err != nil {
		return kindOther, err
	}
	return kindOf(fi.Mode()), nil
}

func (o osOps) readlink(c string) (string, error) {
	t, err := os.Readlink(o.host(c))
	return filepath.ToSlash(t), err
}

func (o osOps) readDir(c string) ([]dirent, error) {
	des, err := os.ReadDir(o.host(c))
	out := make([]dirent, 0, len(des))
	for _, de := range des {
		out = append(out, dirent{name: de.Name(), kind: kindOf(de.Type())})
	}
	return out, err
}

// fsProbe resolves container paths and walks the served tree.
type fsProbe struct{ ops fsOps }

func newFSProbe(root string) fsProbe { return fsProbe{ops: osOps{root: root}} }

// realpath resolves an absolute container path (symlinks followed, ".."
// applied after resolution like the kernel does). A missing component ends
// the resolution lexically: dangling=true and the rest is joined as is.
func (p fsProbe) realpath(c string) (real string, dangling bool, err error) {
	todo := strings.Split(strings.Trim(c, "/"), "/")
	cur := "/"
	hops := 0
	for len(todo) > 0 {
		seg := todo[0]
		todo = todo[1:]
		switch seg {
		case "", ".":
			continue
		case "..":
			cur = path.Dir(cur)
			continue
		}
		next := path.Join(cur, seg)
		kind, err := p.ops.lstat(next)
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				return path.Join(append([]string{next}, todo...)...), true, nil
			}
			return "", false, err
		}
		if kind != kindLink {
			cur = next
			continue
		}
		hops++
		if hops > maxLinkHops {
			return "", false, fmt.Errorf("too many levels of symbolic links: %s", c)
		}
		t, err := p.ops.readlink(next)
		if err != nil {
			return "", false, err
		}
		if strings.HasPrefix(t, "/") {
			cur = "/"
		}
		todo = append(strings.Split(t, "/"), todo...)
	}
	return cur, false, nil
}

func underDir(p, dir string) bool { return p == dir || strings.HasPrefix(p, dir+"/") }

func relTo(p, dir string) string {
	if p == dir {
		return ""
	}
	return strings.TrimPrefix(p, dir+"/")
}

// DataLinks walks the served tree of `docroot` (a /srv/releases/current/…
// container path) and returns the places where /srv/data is reached through a
// release symlink, plus warnings (unreadable directories, bounds hit).
func (p fsProbe) DataLinks(docroot string) ([]DataLink, []string) {
	var (
		links    []DataLink
		warnings []string
		seen     = map[string]bool{}
	)
	add := func(l DataLink) bool {
		key := fmt.Sprintf("%t\x00%s", l.HtaccessOnly, l.Dir)
		if seen[key] {
			return true
		}
		if len(links) >= maxDataLinks {
			warnings = append(warnings, fmt.Sprintf("more than %d release links into %s: the next ones get no web server rule (guard.php still applies)", maxDataLinks, dataRoot))
			return false
		}
		seen[key] = true
		links = append(links, l)
		return true
	}
	releaseReal, _, err := p.realpath(currentRelease)
	if err != nil {
		return nil, []string{fmt.Sprintf("cannot resolve %s: %v", currentRelease, err)}
	}
	docReal, dangling, err := p.realpath(docroot)
	if err != nil || dangling {
		return nil, nil // no docroot (placeholder mode): nothing served
	}

	// .htaccess files are read in every directory from the release down to the
	// docroot (AllowOverride All on /srv/releases), not only inside it.
	if underDir(docroot, currentRelease) {
		for dir := currentRelease; ; {
			p.checkHtaccess(dir, add)
			if dir == docroot {
				break
			}
			next := strings.SplitN(relTo(docroot, dir), "/", 2)[0]
			dir = path.Join(dir, next)
		}
	}
	if underDir(docReal, dataRoot) {
		add(DataLink{Dir: relTo(docroot, currentRelease), DataRel: relTo(docReal, dataRoot)})
		return links, warnings
	}

	type item struct {
		alias, real string
		depth       int
	}
	stack := []item{{alias: docroot, real: docReal}}
	visited := map[string]bool{docReal: true}
	entries := 0
	for len(stack) > 0 {
		it := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		des, err := p.ops.readDir(it.real)
		if err != nil {
			warnings = append(warnings, fmt.Sprintf("cannot list %s: %v", it.alias, err))
			continue
		}
		for _, de := range des {
			entries++
			if entries > maxWalkEntries {
				warnings = append(warnings, fmt.Sprintf("release larger than %d entries: links into %s beyond that get no web server rule (guard.php still applies)", maxWalkEntries, dataRoot))
				return links, warnings
			}
			name := de.name
			alias := it.alias + "/" + name
			real := it.real + "/" + name
			if de.kind != kindLink {
				if de.kind == kindDir {
					stack = append(stack, item{alias: alias, real: real, depth: it.depth})
				}
				continue
			}
			target, dangling, err := p.realpath(real)
			if err != nil {
				continue // loop / unreadable: Apache cannot serve it either
			}
			if name == accessFileName {
				if underDir(target, dataRoot) && !add(DataLink{Dir: relTo(it.alias, currentRelease), DataRel: relTo(target, dataRoot), HtaccessOnly: true}) {
					return links, warnings
				}
				continue
			}
			if underDir(target, dataRoot) {
				if !dangling {
					if k, err := p.ops.lstat(target); err == nil && k != kindDir {
						continue // a file: no directory section to apply, guard.php covers PHP
					}
				}
				if !add(DataLink{Dir: relTo(alias, currentRelease), DataRel: relTo(target, dataRoot)}) {
					return links, warnings
				}
				continue
			}
			// A directory link elsewhere in the release: its content is served
			// under this alias, follow it (bounded, cycle-safe).
			if dangling || !underDir(target, releaseReal) || visited[target] || it.depth >= maxFollowDepth {
				continue
			}
			if k, err := p.ops.lstat(target); err != nil || k != kindDir {
				continue
			}
			visited[target] = true
			stack = append(stack, item{alias: alias, real: target, depth: it.depth + 1})
		}
	}
	sort.Slice(links, func(i, j int) bool {
		if links[i].Dir != links[j].Dir {
			return links[i].Dir < links[j].Dir
		}
		return !links[i].HtaccessOnly && links[j].HtaccessOnly
	})
	return links, warnings
}

// checkHtaccess reports dir/.htaccess when it is a link into /srv/data.
func (p fsProbe) checkHtaccess(dir string, add func(DataLink) bool) {
	dirReal, dangling, err := p.realpath(dir) // only the LAST component is not followed
	if err != nil || dangling {
		return
	}
	f := dirReal + "/" + accessFileName
	if k, err := p.ops.lstat(f); err != nil || k != kindLink {
		return
	}
	if target, _, err := p.realpath(f); err == nil && underDir(target, dataRoot) {
		add(DataLink{Dir: relTo(dir, currentRelease), DataRel: relTo(target, dataRoot), HtaccessOnly: true})
	}
}
