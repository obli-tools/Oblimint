package main

// SiteRuntimeConfig (shared/src/hosting.ts) — loading and STRICT validation.
//
// The JSON is written by the panel (server/src/services/docker/runtimeConfig.ts)
// but the values ultimately come from tenants (docroot, data paths, extensions,
// custom nginx rules). Every value is checked against a whitelist BEFORE it
// reaches a template: an invalid file is refused, never "cleaned up" and
// emitted. The only exception is customNginx, which is the site owner's own
// configuration: when it is unacceptable the site starts WITHOUT it (see
// custom.go), it never prevents the site from starting.

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"regexp"
	"strings"
)

// Container paths (P1-PLAN §4). Kept in one place: templates only use these.
const (
	releasesRoot   = "/srv/releases"
	currentRelease = "/srv/releases/current"
	dataRoot       = "/srv/data"
	shareDir       = "/usr/share/oblimint"
	guardFile      = "/opt/oblimint/guard.php"
	phpFpmSocket   = "/run/php-fpm.sock"
	nginxTempDir   = "/tmp/nginx"
	sessionsDir    = "/tmp/sessions"
	maxConfigBytes = 256 * 1024
	maxDataPaths   = 64
	maxExtensions  = 128
	maxPrefixes    = 64
)

type DataPolicy string

const (
	PolicyPersistent DataPolicy = "persistent"
	PolicyTyped      DataPolicy = "typed"
	PolicyEphemeral  DataPolicy = "ephemeral"
)

type DataPath struct {
	Path              string     `json:"path"`
	Policy            DataPolicy `json:"policy"`
	AllowedExtensions []string   `json:"allowedExtensions"`
}

type PhpSettings struct {
	MemoryLimitMb       int `json:"memoryLimitMb"`
	UploadMaxFilesizeMb int `json:"uploadMaxFilesizeMb"`
	PostMaxSizeMb       int `json:"postMaxSizeMb"`
	MaxExecutionTime    int `json:"maxExecutionTime"`
}

// SiteConfig mirrors SiteRuntimeConfig (version 1). Unknown fields are
// ignored on purpose (forward compatibility); `version` gates breaking changes.
type SiteConfig struct {
	Version         int         `json:"version"`
	SiteID          int64       `json:"siteId"`
	AccountID       int64       `json:"accountId"`
	Role            string      `json:"role"`
	Base            string      `json:"base"`
	Docroot         string      `json:"docroot"`
	BasePath        string      `json:"basePath"`
	ServedPrefixes  []string    `json:"servedPrefixes"`
	DataPaths       []DataPath  `json:"dataPaths"`
	PHP             PhpSettings `json:"php"`
	CustomNginx     *string     `json:"customNginx"`
	HealthcheckPath string      `json:"healthcheckPath"`
}

// Engine of the image the renderer runs in.
type Engine string

const (
	EngineApache Engine = "apache"
	EngineNginx  Engine = "nginx"
	EngineStatic Engine = "static"
)

// siteBases mirrors SITE_BASES (shared/src/hosting.ts): base id → engine.
var siteBases = map[string]Engine{
	"apache-php5.6": EngineApache,
	"apache-php7.4": EngineApache,
	"apache-php8.1": EngineApache,
	"apache-php8.2": EngineApache,
	"apache-php8.3": EngineApache,
	"apache-php8.4": EngineApache,
	"nginx-php8.1":  EngineNginx,
	"nginx-php8.2":  EngineNginx,
	"nginx-php8.3":  EngineNginx,
	"nginx-php8.4":  EngineNginx,
	"nginx-static":  EngineStatic,
}

var (
	segmentRE     = regexp.MustCompile(`^[A-Za-z0-9._@+-]+$`)
	basePathRE    = regexp.MustCompile(`^/([A-Za-z0-9._@+-]+/)*$`)
	extensionRE   = regexp.MustCompile(`^[a-z0-9]{1,10}$`)
	healthcheckRE = regexp.MustCompile(`^/[\x21-\x7e]{0,254}$`)
	// Extensions that must never be whitelisted in a `typed` data path.
	phpLikeExtRE = regexp.MustCompile(`^(php[0-9]?|phar|phtml|pht|phps)$`)
)

// ValidationError lists every problem found (the panel logs them as one message).
type ValidationError struct{ Problems []string }

func (e *ValidationError) Error() string {
	return "invalid site config: " + strings.Join(e.Problems, "; ")
}

// LoadConfig reads and validates a SiteRuntimeConfig file.
func LoadConfig(path string) (*SiteConfig, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return ParseConfig(f)
}

// ParseConfig decodes (size-bounded, single JSON object) and validates.
func ParseConfig(r io.Reader) (*SiteConfig, error) {
	raw, err := io.ReadAll(io.LimitReader(r, maxConfigBytes+1))
	if err != nil {
		return nil, err
	}
	if len(raw) > maxConfigBytes {
		return nil, fmt.Errorf("site config larger than %d bytes", maxConfigBytes)
	}
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	var cfg SiteConfig
	if err := dec.Decode(&cfg); err != nil {
		return nil, fmt.Errorf("site config is not valid JSON: %w", err)
	}
	if dec.More() {
		return nil, errors.New("site config: trailing data after the JSON object")
	}
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	return &cfg, nil
}

// NormalizeRelPath is the Go twin of shared normalizeRelPath(): POSIX,
// trimmed, no leading/trailing slash, no empty / '.' / '..' segment, segments
// of [A-Za-z0-9._@+-] only, ≤ 255 chars. ok=false when invalid.
func NormalizeRelPath(input string, allowEmpty bool) (string, bool) {
	s := strings.TrimSpace(input)
	s = strings.ReplaceAll(s, `\`, "/")
	s = strings.Trim(s, "/")
	if s == "" {
		return "", allowEmpty
	}
	if len(s) > 255 {
		return "", false
	}
	segs := strings.Split(s, "/")
	for _, seg := range segs {
		if seg == "" || seg == "." || seg == ".." || !segmentRE.MatchString(seg) {
			return "", false
		}
	}
	return strings.Join(segs, "/"), true
}

// strictRelPath accepts a relative path only when it is ALREADY normalized
// (the panel always writes normalized values: anything else is suspicious).
func strictRelPath(p string, allowEmpty bool) bool {
	n, ok := NormalizeRelPath(p, allowEmpty)
	return ok && n == p
}

// validPathPrefix: '/' or '/a/b/' with valid segments (normalizePathPrefix twin).
func validPathPrefix(p string) bool {
	if len(p) > 257 || !basePathRE.MatchString(p) {
		return false
	}
	return strictRelPath(strings.Trim(p, "/"), true)
}

// DocrootRel returns the docroot relative to the release root (empty = root).
func (c *SiteConfig) DocrootRel() string {
	if c.Docroot == currentRelease {
		return ""
	}
	return strings.TrimPrefix(c.Docroot, currentRelease+"/")
}

// EngineOfBase returns the engine of the configured base.
func (c *SiteConfig) EngineOfBase() Engine { return siteBases[c.Base] }

// Validate checks every field; it never modifies the config.
func (c *SiteConfig) Validate() error {
	var p []string
	add := func(format string, args ...any) { p = append(p, fmt.Sprintf(format, args...)) }

	if c.Version != 1 {
		add("unsupported version %d (expected 1)", c.Version)
	}
	if c.SiteID <= 0 {
		add("siteId must be a positive integer")
	}
	if c.AccountID <= 0 {
		add("accountId must be a positive integer")
	}
	switch c.Role {
	case "primary", "secondary", "preview":
	default:
		add("invalid role %q", truncate(c.Role))
	}
	if _, ok := siteBases[c.Base]; !ok {
		add("unknown base %q", truncate(c.Base))
	}

	// Docroot: /srv/releases/current or /srv/releases/current/<normalized rel>.
	docrootOK := false
	if c.Docroot == currentRelease {
		docrootOK = true
	} else if rel, found := strings.CutPrefix(c.Docroot, currentRelease+"/"); found && strictRelPath(rel, false) {
		docrootOK = true
	}
	if !docrootOK {
		add("docroot must be %s[/<relative path>], got %q", currentRelease, truncate(c.Docroot))
	}

	if !validPathPrefix(c.BasePath) {
		add("invalid basePath %q (expected '/' or '/a/b/')", truncate(c.BasePath))
	}
	if len(c.ServedPrefixes) > maxPrefixes {
		add("too many servedPrefixes (max %d)", maxPrefixes)
	}
	for _, sp := range c.ServedPrefixes {
		if !validPathPrefix(sp) {
			add("invalid served prefix %q", truncate(sp))
		}
	}

	c.validateDataPaths(docrootOK, add)
	c.validatePHP(add)

	if c.CustomNginx != nil && len(*c.CustomNginx) > maxCustomNginxBytes*4 {
		// Hard cap on the raw field; finer checks (custom.go) only disable the rules.
		add("customNginx is unreasonably large")
	}
	if c.HealthcheckPath != "" && !healthcheckRE.MatchString(c.HealthcheckPath) {
		add("invalid healthcheckPath")
	}

	if len(p) > 0 {
		return &ValidationError{Problems: p}
	}
	return nil
}

func (c *SiteConfig) validateDataPaths(docrootOK bool, add func(string, ...any)) {
	if len(c.DataPaths) > maxDataPaths {
		add("too many dataPaths (max %d)", maxDataPaths)
		return
	}
	seen := map[string]bool{}
	for i, d := range c.DataPaths {
		if !strictRelPath(d.Path, false) {
			add("dataPaths[%d]: invalid path %q", i, truncate(d.Path))
			continue
		}
		switch d.Policy {
		case PolicyPersistent, PolicyTyped, PolicyEphemeral:
		default:
			add("dataPaths[%d]: invalid policy %q", i, truncate(string(d.Policy)))
		}
		if len(d.AllowedExtensions) > maxExtensions {
			add("dataPaths[%d]: too many allowedExtensions (max %d)", i, maxExtensions)
		}
		extSeen := map[string]bool{}
		for _, e := range d.AllowedExtensions {
			switch {
			case !extensionRE.MatchString(e):
				add("dataPaths[%d]: invalid extension %q (expected ^[a-z0-9]{1,10}$)", i, truncate(e))
			case phpLikeExtRE.MatchString(e):
				add("dataPaths[%d]: extension %q can never be served from a data path", i, e)
			case extSeen[e]:
				add("dataPaths[%d]: duplicate extension %q", i, e)
			}
			extSeen[e] = true
		}
		// Overlaps: a data path inside another one would make the rules ambiguous.
		for other := range seen {
			if other == d.Path || strings.HasPrefix(d.Path, other+"/") || strings.HasPrefix(other, d.Path+"/") {
				add("dataPaths[%d]: %q overlaps %q", i, d.Path, other)
			}
		}
		seen[d.Path] = true
		// A data path containing the docroot would turn the whole site into data.
		if docrootOK {
			if root := c.DocrootRel(); root != "" && (root == d.Path || strings.HasPrefix(root, d.Path+"/")) {
				add("dataPaths[%d]: %q contains the docroot", i, d.Path)
			}
		}
	}
}

func (c *SiteConfig) validatePHP(add func(string, ...any)) {
	check := func(name string, v, lo, hi int) {
		if v < lo || v > hi {
			add("php.%s must be between %d and %d (got %d)", name, lo, hi, v)
		}
	}
	check("memoryLimitMb", c.PHP.MemoryLimitMb, 16, 16384)
	check("uploadMaxFilesizeMb", c.PHP.UploadMaxFilesizeMb, 1, 10240)
	check("postMaxSizeMb", c.PHP.PostMaxSizeMb, 1, 10240)
	check("maxExecutionTime", c.PHP.MaxExecutionTime, 1, 86400)
}

func truncate(s string) string {
	if len(s) > 64 {
		return s[:64] + "…"
	}
	return s
}
