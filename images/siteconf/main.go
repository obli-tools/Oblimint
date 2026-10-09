// Command siteconf renders the web server / php-fpm configuration of an
// Oblimint site container from its SiteRuntimeConfig JSON
// (OBLIMINT_SITE_CONFIG, written by the panel). It is compiled into every site
// base image and called by oblimint-entrypoint and oblimint-reload.
//
//	siteconf render --config <file> --engine apache|nginx|static --out /run/oblimint [--php-fpm] [--no-custom]
//	siteconf check  --config <file>
//	siteconf version
//
// Exit codes: 0 success, 1 invalid config / render or write failure, 2 usage.
// Nothing is written when the config is invalid (the running config stays).
package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// version can be overridden at build time with -ldflags "-X main.version=...".
var version = "dev"

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

func run(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		usage(stderr)
		return 2
	}
	switch args[0] {
	case "render":
		return cmdRender(args[1:], stdout, stderr)
	case "check":
		return cmdCheck(args[1:], stdout, stderr)
	case "version", "--version", "-v":
		fmt.Fprintln(stdout, version)
		return 0
	case "help", "--help", "-h":
		usage(stdout)
		return 0
	default:
		fmt.Fprintf(stderr, "siteconf: unknown command %q\n", args[0])
		usage(stderr)
		return 2
	}
}

func usage(w io.Writer) {
	fmt.Fprint(w, `usage:
  siteconf render --config <file> --engine apache|nginx|static --out <dir> [--php-fpm] [--no-custom]
  siteconf check  --config <file>
  siteconf version
`)
}

func cmdCheck(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("check", flag.ContinueOnError)
	fs.SetOutput(stderr)
	configPath := fs.String("config", os.Getenv("OBLIMINT_SITE_CONFIG"), "SiteRuntimeConfig JSON file")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if *configPath == "" {
		fmt.Fprintln(stderr, "siteconf: --config is required (or OBLIMINT_SITE_CONFIG)")
		return 2
	}
	cfg, err := LoadConfig(*configPath)
	if err != nil {
		fmt.Fprintf(stderr, "siteconf: %v\n", err)
		return 1
	}
	if c := CheckCustomNginx(cfg.CustomNginx); c.Rejected != "" {
		fmt.Fprintf(stderr, "siteconf: warning: custom nginx rules would be disabled: %s\n", c.Rejected)
	}
	fmt.Fprintln(stdout, "ok")
	return 0
}

func cmdRender(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("render", flag.ContinueOnError)
	fs.SetOutput(stderr)
	configPath := fs.String("config", os.Getenv("OBLIMINT_SITE_CONFIG"), "SiteRuntimeConfig JSON file")
	engine := fs.String("engine", os.Getenv("OBLIMINT_ENGINE"), "apache | nginx | static")
	out := fs.String("out", "/run/oblimint", "output directory (container path)")
	phpFpm := fs.Bool("php-fpm", false, "also render the php-fpm pool")
	noCustom := fs.Bool("no-custom", false, "render without the custom nginx rules (fallback after a failed nginx -t)")
	fsRoot := fs.String("fs-root", "", "prefix for the docroot existence probe (tests only)")
	modules := fs.String("apache-modules", "/usr/lib/apache2", "Apache modules directory")
	apacheMime := fs.String("apache-mime-types", "/etc/apache2/mime.types", "Apache mime.types")
	nginxMime := fs.String("nginx-mime-types", "/etc/nginx/mime.types", "nginx mime.types")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if *configPath == "" || *engine == "" {
		fmt.Fprintln(stderr, "siteconf: --config and --engine are required")
		return 2
	}
	cfg, err := LoadConfig(*configPath)
	if err != nil {
		fmt.Fprintf(stderr, "siteconf: %v\n", err)
		return 1
	}
	if *noCustom {
		cfg.CustomNginx = nil
	}
	root := *fsRoot
	opt := Options{
		Engine:     Engine(*engine),
		Out:        *out,
		PHPFPM:     *phpFpm,
		ConfigFile: *configPath,
		DocrootExists: func(docroot string) bool {
			st, err := os.Stat(filepath.Join(root, filepath.FromSlash(docroot)))
			return err == nil && st.IsDir()
		},
		// Release links into /srv/data (Apache only: per-directory overrides).
		DataLinks:        newFSProbe(root).DataLinks,
		ApacheModulesDir: *modules,
		ApacheMimeTypes:  *apacheMime,
		NginxMimeTypes:   *nginxMime,
	}
	res, err := Render(cfg, opt)
	if err != nil {
		fmt.Fprintf(stderr, "siteconf: %v\n", err)
		return 1
	}
	for _, w := range res.Warnings {
		fmt.Fprintf(stderr, "siteconf: warning: %s\n", w)
	}
	if err := WriteOutput(filepath.Join(root, filepath.FromSlash(*out)), res); err != nil {
		fmt.Fprintf(stderr, "siteconf: write: %v\n", err)
		return 1
	}
	mode := "site"
	if res.Placeholder {
		mode = "placeholder"
	}
	fmt.Fprintf(stdout, "mode=%s\n", mode)
	return 0
}

var errUnsafeName = errors.New("unsafe output name")
