package codex

import (
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

var (
	// projectHeader is a [projects."<path>"] or [projects.'<path>'] table header in config.toml, as Codex writes it.
	projectHeader = regexp.MustCompile(`^\s*\[\s*projects\.(?:"((?:[^"\\]|\\.)*)"|'([^']*)')\s*\]\s*$`)
	tableHeader   = regexp.MustCompile(`^\s*\[`)
	trustedLevel  = regexp.MustCompile(`^\s*trust_level\s*=\s*(?:"trusted"|'trusted')\s*(?:#.*)?$`)
)

// TrustedFolders are the folders Codex trusts, read from config.toml in the Codex home: each projects table whose trust_level is trusted; none where Codex keeps no configuration yet.
func TrustedFolders(codexHome string) map[string]bool {
	trusted := map[string]bool{}
	text, err := os.ReadFile(filepath.Join(codexHome, "config.toml"))
	if err != nil {
		return trusted
	}
	project, isInProject := "", false
	for _, line := range strings.Split(string(text), "\n") {
		if header := projectHeader.FindStringSubmatch(line); header != nil {
			project, isInProject = header[2], true
			if header[1] != "" {
				// A basic string's escapes read as JSON's do; a literal string has none.
				if unquoted, err := strconv.Unquote(`"` + header[1] + `"`); err == nil {
					project = unquoted
				} else {
					isInProject = false
				}
			}
		} else if tableHeader.MatchString(line) {
			isInProject = false
		} else if isInProject && trustedLevel.MatchString(line) {
			trusted[project] = true
		}
	}
	return trusted
}

// HomeOf is Codex's home: CODEX_HOME when it is set, else .codex in the user's home folder.
func HomeOf(homeDirectory string, codexHome string) string {
	if codexHome == "" {
		return filepath.Join(homeDirectory, ".codex")
	}
	return codexHome
}
