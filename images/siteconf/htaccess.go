package main

// Access control of the .htaccess files, for OpenLiteSpeed (litespeed bases).
//
// OpenLiteSpeed reads only the rewrite rules of a .htaccess: "Deny from all",
// "Require all denied", <Files wp-config.php> … or an Auth* password are
// IGNORED, so a folder an Apache site keeps private would be served. Closed
// by default instead: at every render (start, oblimint-reload: every
// publication and rollback) the release is walked, the access directives of
// each .htaccess are read and
//
//   - the common forms are reproduced: a total refusal of a folder
//     (Require all denied, Deny from all, Order … + Deny from all) → 403 for
//     the folder and everything below it; <Files x> / <FilesMatch re> holding
//     a total refusal → 403 for those files in that folder and below;
//   - everything that cannot be reproduced faithfully (Auth* / Require
//     valid-user, Allow from <ip>, Require ip / host / env / expr, <Limit>,
//     <If>, <RequireAny>…, an unreadable or oversized .htaccess) closes its
//     scope: the folder (or the files of the <Files> section) answers 403,
//     never served publicly, and a warning says why.
//
// A more permissive rule BELOW a refused folder (re-allowing a sub-folder) is
// not reproduced: the refusal wins (closed). Ancestors of the docroot inside
// the release apply to the whole site, like Apache; folders outside the
// docroot are not reachable and ignored. Directory links inside the release
// get the rules of their target (the URL through the link is refused too).

import (
	"bufio"
	"bytes"
	"fmt"
	"os"
	"path"
	"regexp"
	"sort"
	"strings"
)

// AccessAction: what a rule does.
type AccessAction string

const (
	// AccessDeny: a refusal reproduced as is.
	AccessDeny AccessAction = "deny"
	// AccessClosed: directives that cannot be reproduced; refused (fail closed).
	AccessClosed AccessAction = "closed"
	// AccessAllow: a <Files> / <FilesMatch> section granting everything (e.g.
	// the assets a plugin re-allows in a folder it refuses as a whole).
	AccessAllow AccessAction = "allow"
)

// FilePatternKind of a <Files> / <FilesMatch> section.
type FilePatternKind string

const (
	FilesName  FilePatternKind = "name"
	FilesGlob  FilePatternKind = "glob"
	FilesRegex FilePatternKind = "regex"
)

// AccessRule: one refusal derived from a .htaccess.
type AccessRule struct {
	// Dir: folder of the .htaccess, relative to the release root ("" = root),
	// raw on-disk bytes.
	Dir string
	// Files: nil = the whole folder (and below); else the files matched.
	Files *FilePattern
	// Paths: FilesRegex that cannot be written into the server configuration:
	// the files of the release it matches (relative to the release root).
	Paths  []string
	Action AccessAction
	// Directive: the deciding directive (e.g. "Deny from all", "AuthType Basic").
	Directive string
}

// FilePattern of a <Files> / <FilesMatch> section.
type FilePattern struct {
	Kind    FilePatternKind
	Pattern string
}

const (
	maxHtaccessBytes = 256 * 1024
	maxHtaccessFiles = 2000
	maxAccessRules   = 512
	maxRegexPaths    = 200
)

var (
	authDirectiveRE = regexp.MustCompile(`(?i)^(auth[a-z]*|anonymous[a-z_]*)$`)
	sectionOpenRE   = regexp.MustCompile(`^<\s*([A-Za-z]+)\s*(.*?)\s*>$`)
	sectionCloseRE  = regexp.MustCompile(`^<\s*/\s*([A-Za-z]+)\s*>$`)
	// Containers that only gate on the server build: their content counts.
	transparentSections = map[string]bool{"ifmodule": true, "ifdefine": true, "ifversion": true, "ifdirective": true, "iffile": true, "ifsection": true}
	// Containers whose conditions cannot be reproduced: access directives inside close the scope.
	complexSections = map[string]bool{
		"limit": true, "limitexcept": true, "if": true, "elseif": true, "else": true,
		"requireall": true, "requireany": true, "requirenone": true,
		"directory": true, "directorymatch": true, "location": true, "locationmatch": true,
	}
)

// accessScope collects the access directives of one scope (the folder, or one <Files> section).
type accessScope struct {
	files    *FilePattern
	requires [][]string
	allows   []string
	denies   []string
	order    string
	auth     string // first Auth* directive
	complex  string // first access directive inside a complex container
	other    string // first access directive that cannot be reproduced
}

func (s *accessScope) has() bool {
	return len(s.requires) > 0 || len(s.allows) > 0 || len(s.denies) > 0 || s.order != "" || s.auth != "" || s.complex != "" || s.other != ""
}

// verdict: deny (reproduced), closed (unsupported) or "" (allowed / nothing).
func (s *accessScope) verdict() (AccessAction, string) {
	if s.auth != "" {
		return AccessClosed, s.auth
	}
	if s.complex != "" {
		return AccessClosed, s.complex
	}
	if s.other != "" {
		return AccessClosed, s.other
	}
	deny, granted := "", ""
	for _, r := range s.requires {
		arg := strings.ToLower(strings.Join(r, " "))
		switch arg {
		case "all denied":
			deny = "Require all denied"
		case "all granted":
			granted = "Require all granted"
		default:
			return AccessClosed, "Require " + strings.Join(r, " ")
		}
	}
	allowAll, denyAll := false, false
	for _, h := range s.allows {
		if strings.ToLower(h) != "all" {
			return AccessClosed, "Allow from " + h
		}
		allowAll = true
	}
	for _, h := range s.denies {
		if strings.ToLower(h) != "all" {
			return AccessClosed, "Deny from " + h
		}
		denyAll = true
	}
	if len(s.allows) > 0 || len(s.denies) > 0 || s.order != "" {
		order := strings.ReplaceAll(strings.ToLower(s.order), " ", "")
		refused := false
		switch order {
		case "", "deny,allow":
			refused = denyAll && !allowAll
		case "allow,deny":
			refused = !allowAll || denyAll
		default: // mutual-failure, unknown
			return AccessClosed, "Order " + s.order
		}
		if refused && deny == "" {
			deny = "Deny from all"
			if !denyAll {
				deny = "Order " + s.order
			}
		}
		if !refused && allowAll && granted == "" {
			granted = "Allow from all"
		}
	}
	if deny != "" {
		return AccessDeny, deny
	}
	if granted != "" {
		return AccessAllow, granted
	}
	return "", ""
}

// splitArgs: whitespace-separated words, double quotes grouping.
func splitArgs(s string) []string {
	var out []string
	var cur strings.Builder
	inQ, has := false, false
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c == '"':
			inQ = !inQ
			has = true
		case !inQ && (c == ' ' || c == '\t'):
			if has {
				out = append(out, cur.String())
				cur.Reset()
				has = false
			}
		default:
			cur.WriteByte(c)
			has = true
		}
	}
	if has {
		out = append(out, cur.String())
	}
	return out
}

// filesPattern of a <Files …> / <FilesMatch …> opening (nil when unreadable).
func filesPattern(name, args string) *FilePattern {
	a := splitArgs(args)
	if strings.EqualFold(name, "filesmatch") {
		if len(a) != 1 {
			return nil
		}
		return &FilePattern{Kind: FilesRegex, Pattern: a[0]}
	}
	if len(a) == 2 && a[0] == "~" {
		return &FilePattern{Kind: FilesRegex, Pattern: a[1]}
	}
	if len(a) != 1 || a[0] == "" {
		return nil
	}
	if strings.ContainsAny(a[0], "*?[") {
		return &FilePattern{Kind: FilesGlob, Pattern: a[0]}
	}
	return &FilePattern{Kind: FilesName, Pattern: a[0]}
}

// ParseHtaccessAccess: the refusals of one .htaccess (Dir left empty: set by the caller).
func ParseHtaccessAccess(content []byte) []AccessRule {
	dir := &accessScope{}
	scopes := []*accessScope{dir}
	type frame struct {
		name  string
		scope *accessScope // the scope this container belongs to
		files *accessScope // <Files> scope it opened (nil otherwise)
	}
	var stack []frame
	current := func() *accessScope {
		for i := len(stack) - 1; i >= 0; i-- {
			if stack[i].files != nil {
				return stack[i].files
			}
		}
		return dir
	}
	inComplex := func() string {
		for i := len(stack) - 1; i >= 0; i-- {
			if complexSections[stack[i].name] {
				return "<" + stack[i].name + ">"
			}
		}
		return ""
	}
	var unclosed string

	sc := bufio.NewScanner(bytes.NewReader(content))
	sc.Buffer(make([]byte, 64*1024), maxHtaccessBytes+1)
	var line strings.Builder
	for sc.Scan() {
		raw := strings.TrimRight(sc.Text(), "\r")
		if strings.HasSuffix(raw, "\\") {
			line.WriteString(strings.TrimSuffix(raw, "\\"))
			line.WriteByte(' ')
			continue
		}
		line.WriteString(raw)
		l := strings.TrimSpace(line.String())
		line.Reset()
		if l == "" || strings.HasPrefix(l, "#") {
			continue
		}
		if m := sectionCloseRE.FindStringSubmatch(l); m != nil {
			name := strings.ToLower(m[1])
			for i := len(stack) - 1; i >= 0; i-- {
				if stack[i].name == name {
					stack = stack[:i]
					break
				}
			}
			continue
		}
		if m := sectionOpenRE.FindStringSubmatch(l); m != nil {
			name := strings.ToLower(m[1])
			f := frame{name: name, scope: current()}
			if name == "files" || name == "filesmatch" {
				fs := &accessScope{files: filesPattern(name, m[2])}
				if fs.files == nil {
					// Unreadable section: its content closes the enclosing scope.
					fs.other = "<" + m[1] + " " + m[2] + ">"
					fs.files = nil
				}
				scopes = append(scopes, fs)
				f.files = fs
			}
			stack = append(stack, f)
			continue
		}
		words := splitArgs(l)
		if len(words) == 0 {
			continue
		}
		d := strings.ToLower(words[0])
		args := words[1:]
		s := current()
		isAccess := d == "require" || d == "allow" || d == "deny" || d == "order" || d == "satisfy" || authDirectiveRE.MatchString(d)
		if !isAccess {
			continue
		}
		if c := inComplex(); c != "" {
			// Only an explicit "grant everything" is harmless inside a condition.
			if !(d == "require" && strings.EqualFold(strings.Join(args, " "), "all granted")) &&
				!(d == "allow" && len(args) == 2 && strings.EqualFold(args[1], "all")) {
				if s.complex == "" {
					s.complex = c + " " + words[0] + " " + strings.Join(args, " ")
				}
			}
			continue
		}
		switch {
		case authDirectiveRE.MatchString(d):
			if s.auth == "" {
				s.auth = strings.TrimSpace(words[0] + " " + strings.Join(args, " "))
			}
		case d == "require":
			low := strings.ToLower(strings.Join(args, " "))
			if strings.HasPrefix(low, "valid-user") || strings.HasPrefix(low, "user ") || strings.HasPrefix(low, "group ") {
				if s.auth == "" {
					s.auth = "Require " + strings.Join(args, " ")
				}
			} else {
				s.requires = append(s.requires, args)
			}
		case d == "allow" || d == "deny":
			// "Allow from a b c" — "from" is required.
			if len(args) < 2 || !strings.EqualFold(args[0], "from") {
				if s.other == "" {
					s.other = words[0] + " " + strings.Join(args, " ")
				}
				continue
			}
			if d == "allow" {
				s.allows = append(s.allows, args[1:]...)
			} else {
				s.denies = append(s.denies, args[1:]...)
			}
		case d == "order":
			s.order = strings.Join(args, "")
		case d == "satisfy":
			if !strings.EqualFold(strings.Join(args, ""), "all") && s.other == "" {
				s.other = "Satisfy " + strings.Join(args, " ")
			}
		}
	}
	if sc.Err() != nil {
		return []AccessRule{{Action: AccessClosed, Directive: ".htaccess illisible"}}
	}
	for _, f := range stack {
		if f.files != nil || complexSections[f.name] {
			unclosed = "<" + f.name + "> non fermé"
		}
	}
	if unclosed != "" {
		return []AccessRule{{Action: AccessClosed, Directive: unclosed}}
	}

	var out []AccessRule
	for _, s := range scopes {
		if !s.has() {
			continue
		}
		action, directive := s.verdict()
		// A grant only matters for files (an exception in a refused folder).
		if action == "" || (action == AccessAllow && (s == dir || s.files == nil)) {
			continue
		}
		r := AccessRule{Action: action, Directive: directive}
		if s != dir {
			if s.files == nil {
				// Unreadable <Files> header: the whole folder.
				r.Files = nil
			} else {
				r.Files = s.files
			}
		}
		out = append(out, r)
	}
	return out
}

// HtaccessAccess walks the current release (real folders, links never
// followed; directory links inside the release are mapped onto their target)
// and returns the refusals of its .htaccess files, plus warnings.
func (p fsProbe) HtaccessAccess(docroot string) ([]AccessRule, []string) {
	o, ok := p.ops.(osOps)
	if !ok {
		return nil, nil
	}
	var rules []AccessRule
	var warnings []string
	files := map[string][]string{} // dir → file names (FilesRegex fallback)
	var dirs []string
	type link struct{ dir, target string }
	var links []link
	entries, nHt := 0, 0
	truncated := false
	var walk func(rel string)
	walk = func(rel string) {
		if truncated {
			return
		}
		c := currentRelease
		if rel != "" {
			c += "/" + rel
		}
		des, err := p.ops.readDir(c)
		if err != nil {
			return
		}
		dirs = append(dirs, rel)
		for _, de := range des {
			entries++
			if entries > maxWalkEntries {
				truncated = true
				return
			}
			child := de.name
			if rel != "" {
				child = rel + "/" + de.name
			}
			switch de.kind {
			case kindDir:
				walk(child)
			case kindLink:
				real, _, err := p.realpath(currentRelease + "/" + child)
				if err == nil && strings.HasPrefix(real+"/", releasesRoot+"/") {
					if t, ok := releaseRel(real); ok && t != child {
						links = append(links, link{dir: child, target: t})
					}
				}
			default:
				files[rel] = append(files[rel], de.name)
				if de.name != accessFileName {
					continue
				}
				nHt++
				if nHt > maxHtaccessFiles {
					rules = append(rules, AccessRule{Dir: rel, Action: AccessClosed, Directive: "trop de fichiers .htaccess"})
					continue
				}
				b, err := readBounded(o.host(currentRelease+"/"+child), maxHtaccessBytes)
				if err != nil {
					rules = append(rules, AccessRule{Dir: rel, Action: AccessClosed, Directive: ".htaccess illisible ou trop grand"})
					continue
				}
				for _, r := range ParseHtaccessAccess(b) {
					r.Dir = rel
					rules = append(rules, r)
				}
			}
		}
	}
	walk("")
	if truncated {
		warnings = append(warnings, fmt.Sprintf(".htaccess access rules: the walk stopped at %d entries (release too large)", maxWalkEntries))
	}
	// Regex sections that cannot be written in the configuration: the matching files of the release.
	for i := range rules {
		r := &rules[i]
		if r.Files == nil || r.Files.Kind != FilesRegex || fileRegexSafe(r.Files.Pattern) {
			continue
		}
		re, err := regexp.Compile(r.Files.Pattern)
		if err != nil {
			r.Files = nil // not even readable: the whole folder
			continue
		}
		for _, d := range dirs {
			if !underDir(d, r.Dir) && r.Dir != "" {
				continue
			}
			for _, name := range files[d] {
				if re.MatchString(name) {
					p := name
					if d != "" {
						p = d + "/" + name
					}
					r.Paths = append(r.Paths, p)
				}
			}
		}
		if len(r.Paths) > maxRegexPaths {
			r.Paths, r.Files = nil, nil
		}
		sort.Strings(r.Paths)
	}
	// Links inside the release: the target's rules apply through the link too.
	n := len(rules)
	for _, l := range links {
		for _, r := range rules[:n] {
			switch {
			case r.Dir != "" && underDir(l.target, r.Dir):
				if r.Files == nil && len(r.Paths) == 0 {
					rules = append(rules, AccessRule{Dir: l.dir, Action: r.Action, Directive: r.Directive})
				} else if r.Files != nil && len(r.Paths) == 0 {
					rules = append(rules, AccessRule{Dir: l.dir, Files: r.Files, Action: r.Action, Directive: r.Directive})
				}
			case l.target == "" && r.Dir != "", l.target != "" && underDir(r.Dir, l.target):
				nr := r
				if l.target == "" {
					nr.Dir = l.dir + "/" + r.Dir
				} else {
					nr.Dir = l.dir + strings.TrimPrefix(r.Dir, l.target)
				}
				nr.Paths = nil
				if len(r.Paths) > 0 {
					continue
				}
				rules = append(rules, nr)
			}
		}
	}
	if len(rules) > maxAccessRules {
		warnings = append(warnings, fmt.Sprintf(".htaccess access rules: %d found, the release root is closed", len(rules)))
		rules = []AccessRule{{Dir: "", Action: AccessClosed, Directive: "trop de règles d'accès"}}
	}
	for _, r := range rules {
		if r.Action == AccessClosed {
			warnings = append(warnings, fmt.Sprintf("%s/.htaccess: %q cannot be reproduced by OpenLiteSpeed: %s answers 403", dirLabel(r.Dir), r.Directive, scopeLabel(r)))
		}
	}
	return rules, warnings
}

func dirLabel(d string) string {
	if d == "" {
		return "."
	}
	return globPath(d)
}

func scopeLabel(r AccessRule) string {
	if r.Files != nil {
		return fmt.Sprintf("files %q of %s/", r.Files.Pattern, dirLabel(r.Dir))
	}
	return dirLabel(r.Dir) + "/"
}

// releaseRel: path relative to the release root of a real path under /srv/releases/<n>/.
func releaseRel(real string) (string, bool) {
	rest, ok := strings.CutPrefix(real, releasesRoot+"/")
	if !ok {
		return "", false
	}
	i := strings.IndexByte(rest, '/')
	if i < 0 {
		return "", true
	}
	return rest[i+1:], true
}

func readBounded(file string, max int) ([]byte, error) {
	f, err := os.Open(file)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || !st.Mode().IsRegular() {
		return nil, fmt.Errorf("not a regular file")
	}
	if st.Size() > int64(max) {
		return nil, fmt.Errorf("too large")
	}
	b := make([]byte, st.Size())
	_, err = f.ReadAt(b, 0)
	if err != nil && st.Size() > 0 {
		return nil, err
	}
	return b, nil
}

// ── rendering (OpenLiteSpeed regex contexts) ────────────────────────────────

var regexSafeRE = regexp.MustCompile(`^[A-Za-z0-9._@+/:=?!$|*^()\[\]\\,-]{1,512}$`)

// fileRegexSafe: a FilesMatch regex that can go into a context: whitelisted
// characters, compiles, no "^" but a leading one (anchoring is rewritten),
// no top-level alternation behind a leading "^".
func fileRegexSafe(re string) bool {
	if !regexSafeRE.MatchString(re) {
		return false
	}
	if _, err := regexp.Compile(re); err != nil {
		return false
	}
	depth, inClass := 0, false
	for i := 0; i < len(re); i++ {
		c := re[i]
		switch {
		case c == '\\':
			i++
		case inClass:
			if c == ']' {
				inClass = false
			}
		case c == '[':
			inClass = true
			if i+1 < len(re) && re[i+1] == '^' {
				i++
			}
		case c == '(':
			depth++
		case c == ')':
			depth--
		case c == '^' && i != 0:
			return false
		case c == '|' && depth == 0 && strings.HasPrefix(re, "^"):
			return false
		}
	}
	return true
}

// globRegex: an Apache wildcard (<Files *.log>) as a regex of one path segment.
func globRegex(g string) string {
	var b strings.Builder
	for i := 0; i < len(g); i++ {
		c := g[i]
		switch c {
		case '*':
			b.WriteString("[^/]*")
		case '?':
			b.WriteString("[^/]")
		case '[':
			j := strings.IndexByte(g[i:], ']')
			if j < 0 {
				b.WriteString(`\[`)
				continue
			}
			class := g[i+1 : i+j]
			class = strings.TrimPrefix(class, "!")
			neg := len(class) != len(g[i+1:i+j])
			b.WriteByte('[')
			if neg {
				b.WriteByte('^')
			}
			for k := 0; k < len(class); k++ {
				if !safeByte(class[k]) || class[k] == '/' {
					b.WriteByte('.')
					continue
				}
				b.WriteByte(class[k])
			}
			b.WriteByte(']')
			i += j
		default:
			b.WriteString(bytesRegex(string(c)))
		}
	}
	return b.String()
}

// accessURLRegex: regex of the URL folder of a release folder ("" = outside
// the docroot, not reachable). Ends with '/'.
func accessURLRegex(cfg *SiteConfig, dir string) (string, bool) {
	root := cfg.DocrootRel()
	base, err := pathRegex(cfg.BasePath)
	if err != nil {
		return "", false
	}
	switch {
	case root == "" && dir == "", root != "" && (dir == "" || root == dir || strings.HasPrefix(root, dir+"/")):
		return base, true
	case root == "":
		return base + bytesRegex(dir) + "/", true
	case strings.HasPrefix(dir, root+"/"):
		return base + bytesRegex(strings.TrimPrefix(dir, root+"/")) + "/", true
	}
	return "", false
}

// fileCheck: a look-ahead body matching one path SEGMENT against a <Files>
// pattern, applied at the start of a segment. The end of the name is "(?=/|$)",
// not "$": a script is also reached with a PATH_INFO (/wp-config.php/x runs
// wp-config.php), so the refused name may be followed by "/…". ok=false when
// it cannot be written.
func fileCheck(fp *FilePattern) (string, bool) {
	switch fp.Kind {
	case FilesName:
		return bytesRegex(fp.Pattern) + segmentEnd, true
	case FilesGlob:
		return globRegex(fp.Pattern) + segmentEnd, true
	case FilesRegex:
		if !fileRegexSafe(fp.Pattern) {
			return "", false
		}
		re := segmentDollar(fp.Pattern)
		if strings.HasPrefix(re, "^") {
			return re[1:], true
		}
		return "[^/]*?(?:" + re + ")", true
	}
	return "", false
}

// segmentEnd: the end of a path segment (the end of the URI, or a PATH_INFO).
const segmentEnd = "(?=/|$)"

// segmentDollar: every "$" anchor of a <FilesMatch> regex (outside escapes and
// character classes) made the end of the segment.
func segmentDollar(re string) string {
	var b strings.Builder
	inClass := false
	for i := 0; i < len(re); i++ {
		c := re[i]
		switch {
		case c == '\\' && i+1 < len(re):
			b.WriteByte(c)
			i++
			b.WriteByte(re[i])
			continue
		case inClass:
			if c == ']' {
				inClass = false
			}
		case c == '[':
			inClass = true
			// "[^…" and a leading "]" belong to the class.
			b.WriteByte(c)
			if i+1 < len(re) && re[i+1] == '^' {
				i++
				b.WriteByte(re[i])
			}
			if i+1 < len(re) && re[i+1] == ']' {
				i++
				b.WriteByte(re[i])
			}
			continue
		case c == '$':
			b.WriteString(segmentEnd)
			continue
		}
		b.WriteByte(c)
	}
	return b.String()
}

// relUnder: path of p relative to dir ("" = dir is the release root), ok when p is strictly below.
func relUnder(p, dir string) (string, bool) {
	if dir == "" {
		return p, p != ""
	}
	r, ok := strings.CutPrefix(p, dir+"/")
	return r, ok && r != ""
}

// lsAccessContexts: the contexts of the access rules. Refusals start with
// "(?:^": they sort before every serving regex context (OpenLiteSpeed sorts
// the contexts by URI and the first matching regex wins). Grants (files a
// <Files> section re-allows in a refused folder, e.g. the assets of a
// plugin) start with "(?:(?:^", sorting before the refusals, and never match:
// a sub-folder refused on its own, a file refused by any <Files> rule of the
// release, a data path (or a release link into /srv/data), a hidden path, a
// PHP variant. dataDirs: release-relative data folders.
func lsAccessContexts(cfg *SiteConfig, rules []AccessRule, dataDirs []string) []lsContext {
	seen := map[string]bool{}
	var out []lsContext
	add := func(c lsContext) bool {
		if _, err := lsv(c.URI); err != nil {
			return false
		}
		if c.Location != "" {
			if _, err := lsv(c.Location); err != nil {
				return false
			}
		}
		if !seen[c.URI] {
			seen[c.URI] = true
			out = append(out, c)
		}
		return true
	}
	deny := func(uri, comment string) bool { return add(lsContext{URI: uri, Comment: comment}) }
	// The whole folder (and below); "/" = the whole site but never the
	// built-in pages (ping, 404).
	addDir := func(dirRe, comment string) {
		if dirRe == "/" {
			deny("exp:(?:^/(?!__oblimint/))", comment)
			return
		}
		deny("exp:(?:^"+strings.TrimSuffix(dirRe, "/")+"(?:/|$))", comment)
	}
	var grants []AccessRule
	for _, r := range rules {
		if r.Action == AccessAllow {
			grants = append(grants, r)
			continue
		}
		dirRe, ok := accessURLRegex(cfg, r.Dir)
		if !ok {
			continue
		}
		comment := fmt.Sprintf("%s/.htaccess: %s (%s)", dirLabel(r.Dir), sanitizeComment(r.Directive), r.Action)
		switch {
		case len(r.Paths) > 0:
			for _, p := range r.Paths {
				d, name := path.Split(p)
				dre, ok := accessURLRegex(cfg, strings.TrimSuffix(d, "/"))
				if !ok {
					continue
				}
				if !deny("exp:(?:^"+dre+bytesRegex(name)+"(?:/|$))", comment) {
					addDir(dirRe, comment)
				}
			}
		case r.Files == nil:
			addDir(dirRe, comment)
		default:
			check, ok := fileCheck(r.Files)
			// Never served when it cannot be written: the whole folder.
			// Any segment of the URI below the folder: the file itself, or a PATH_INFO after it.
			if !ok || !deny("exp:(?:^"+dirRe+"(?:.*/)?(?="+check+"))", comment) {
				addDir(dirRe, comment)
			}
		}
	}

	// Grants: only inside a refused folder, never weaker than a refusal: no
	// segment of the URI may be a refused file or a script (a PATH_INFO after
	// x.php or wp-config.php would run it).
	var negFiles []string
	for _, r := range rules {
		if r.Action == AccessAllow || r.Files == nil {
			continue
		}
		if len(r.Paths) > 0 {
			return out // explicit file lists: no exception is written (closed side)
		}
		check, ok := fileCheck(r.Files)
		if !ok {
			return out
		}
		negFiles = append(negFiles, check)
	}
	noSegment := ""
	if len(negFiles) > 0 {
		noSegment = "(?!(?:[^/]*/)*(?:" + strings.Join(negFiles, "|") + "))"
	}
	for _, g := range grants {
		if g.Files == nil || len(g.Paths) > 0 || globPath(g.Dir) != g.Dir {
			continue
		}
		refused := false
		var subs []string
		for _, r := range rules {
			if r.Action == AccessAllow || r.Files != nil || len(r.Paths) > 0 {
				continue
			}
			if r.Dir == g.Dir || r.Dir == "" || strings.HasPrefix(g.Dir, r.Dir+"/") {
				refused = true
			} else if rel, ok := relUnder(r.Dir, g.Dir); ok {
				subs = append(subs, bytesRegex(rel))
			}
		}
		if !refused {
			continue
		}
		for _, d := range dataDirs {
			if rel, ok := relUnder(d, g.Dir); ok {
				subs = append(subs, bytesRegex(rel))
			}
		}
		dirRe, ok := accessURLRegex(cfg, g.Dir)
		check, ok2 := fileCheck(g.Files)
		if !ok || !ok2 {
			continue
		}
		// Container folder served by that URL folder (an ancestor of the docroot: the docroot).
		location := cfg.Docroot
		if rel := cfg.DocrootRel(); g.Dir != "" && (rel == "" || strings.HasPrefix(g.Dir, rel+"/")) {
			location = currentRelease + "/" + g.Dir
		}
		excl := ""
		if len(subs) > 0 {
			sort.Strings(subs)
			excl = "(?!(?:" + strings.Join(subs, "|") + ")(?:/|$))"
		}
		uri := "exp:(?:(?:^" + dirRe + excl + `((?!(?:[^/]*/)*\.)` + noSegment +
			`(?!(?:[^/]*/)*(?i:[^/]*\.(?:php[0-9]?|phar|phtml|pht|phps))/)(?:.*/)?(?=` + check + ")" +
			`(?!(?i:[^/]*\.(?:php[0-9]|phar|phtml|pht|phps)$))[^/]*)$))`
		add(lsContext{
			URI: uri, Location: location + "/$1", Allow: true, NoRewrite: true,
			Comment: fmt.Sprintf("%s/.htaccess: %s for %q (exception of a refused folder)", dirLabel(g.Dir), sanitizeComment(g.Directive), g.Files.Pattern),
		})
	}
	return out
}

func sanitizeComment(s string) string {
	b := []byte(s)
	for i := range b {
		if b[i] < 0x20 || b[i] == 0x7f || b[i] == '{' || b[i] == '}' {
			b[i] = '?'
		}
	}
	if len(b) > 120 {
		b = append(b[:120], "…"...)
	}
	return string(b)
}
