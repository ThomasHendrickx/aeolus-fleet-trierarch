package workspace

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// The skills at the root of a ship folder (docs/design/ship-folder.md, point 8): the root's `.claude/skills/<skill>` and
// `.agents/skills/<skill>` each link to the skill of that name in `main/` and every sub-repository, so both harnesses load them all at
// start. A name two repositories share with the same content is one link, the first repository's; with different content neither is
// linked, and the clash is answered for the root AGENTS.md to say.

// skillFolders are the folder each harness reads skills from, in a repository and at the root.
var skillFolders = []string{".claude/skills", ".agents/skills"}

// SkillClash is a skill name that repositories hold with different content, in one harness's folder: where each is, from the ship folder.
type SkillClash struct {
	Skill string
	Paths []string
}

type heldSkill struct {
	path   string
	digest string
}

// linkSkills makes the root's skill folders again from the repositories as they are now, whatever the session left there: none for a
// harness whose folder no repository has a skill in. `repositories` are their folders from the ship folder, such as `main`. Answers each
// clash, in the order of the folders and of the repositories.
func linkSkills(folder string, repositories []string) ([]SkillClash, error) {
	clashes := []SkillClash{}
	for _, skillFolder := range skillFolders {
		root := filepath.Join(folder, skillFolder)
		// A harness folder the session left as a link (into a repository) goes as the link only; removing through it would delete the repository's skills.
		if info, err := os.Lstat(filepath.Dir(root)); err == nil && info.Mode()&os.ModeSymlink != 0 {
			if err := os.Remove(filepath.Dir(root)); err != nil {
				return nil, err
			}
		}
		if err := os.RemoveAll(root); err != nil {
			return nil, err
		}
		// The harness's folder goes too when that leaves it empty, and stays when the session keeps its own files in it.
		_ = os.Remove(filepath.Dir(root))
		names := []string{}
		held := map[string][]heldSkill{}
		for _, repository := range repositories {
			found, err := skillsIn(filepath.Join(folder, repository, skillFolder))
			if err != nil {
				return nil, err
			}
			for _, skill := range found {
				if _, seen := held[skill.name]; !seen {
					names = append(names, skill.name)
				}
				held[skill.name] = append(held[skill.name], heldSkill{path: fmt.Sprintf("%s/%s/%s", repository, skillFolder, skill.name), digest: skill.digest})
			}
		}
		for _, name := range names {
			each := held[name]
			if !allShare(each) {
				paths := []string{}
				for _, one := range each {
					paths = append(paths, one.path)
				}
				clashes = append(clashes, SkillClash{Skill: name, Paths: paths})
				continue
			}
			if err := os.MkdirAll(root, 0o755); err != nil {
				return nil, err
			}
			target, err := filepath.Rel(root, filepath.Join(folder, each[0].path))
			if err != nil {
				return nil, err
			}
			if err := os.Symlink(target, filepath.Join(root, name)); err != nil {
				return nil, err
			}
		}
	}
	return clashes, nil
}

func allShare(each []heldSkill) bool {
	for _, one := range each {
		if one.digest != each[0].digest {
			return false
		}
	}
	return true
}

type skillIn struct {
	name   string
	digest string
}

// skillsIn are the skills a repository holds in a skill folder: each a folder, or a link to one, with a digest of everything in it.
func skillsIn(skillFolder string) ([]skillIn, error) {
	entries, err := os.ReadDir(skillFolder)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	found := []skillIn{}
	for _, entry := range entries {
		path := filepath.Join(skillFolder, entry.Name())
		if info, err := os.Stat(path); err != nil || !info.IsDir() {
			continue
		}
		digest, _, err := digestOf(path, map[string]bool{})
		if err != nil {
			return nil, err
		}
		found = append(found, skillIn{name: entry.Name(), digest: digest})
	}
	return found, nil
}

// digestOf is a digest of every file under a folder, by its path in it and its content, following links; a folder reached twice on the
// way down is left out, and a folder with no file below it counts for nothing (hasFile false).
func digestOf(folder string, above map[string]bool) (string, bool, error) {
	here, err := filepath.EvalSymlinks(folder)
	if err != nil {
		return "", false, err
	}
	hash := sha256.New()
	if above[here] {
		return hex.EncodeToString(hash.Sum(nil)), false, nil
	}
	entries, err := os.ReadDir(folder)
	if err != nil {
		return "", false, err
	}
	names := []string{}
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	sort.Strings(names)
	below := map[string]bool{here: true}
	for path := range above {
		below[path] = true
	}
	hasFile := false
	for _, name := range names {
		path := filepath.Join(folder, name)
		info, err := os.Stat(path)
		switch {
		case err != nil:
			continue
		case info.IsDir():
			inner, innerHasFile, err := digestOf(path, below)
			if err != nil {
				return "", false, err
			}
			if innerHasFile {
				fmt.Fprintf(hash, "dir %s\x00%s\x00", name, inner)
				hasFile = true
			}
		case info.Mode().IsRegular():
			content, err := os.ReadFile(path)
			if err != nil {
				return "", false, err
			}
			fmt.Fprintf(hash, "file %s\x00", name)
			hash.Write(content)
			hash.Write([]byte{0})
			hasFile = true
		}
	}
	return hex.EncodeToString(hash.Sum(nil)), hasFile, nil
}

// clashesText is the root AGENTS.md's words on skills that repositories hold with different content; none when there is no clash.
func clashesText(clashes []SkillClash) []string {
	if len(clashes) == 0 {
		return nil
	}
	lines := []string{"## Skills the repositories disagree on", ""}
	for _, clash := range clashes {
		quoted := []string{}
		for _, path := range clash.Paths {
			quoted = append(quoted, "`"+path+"`")
		}
		where := strings.Join(quoted[:len(quoted)-1], ", ") + " and " + quoted[len(quoted)-1]
		before := "either"
		if len(clash.Paths) > 2 {
			before = "any of them"
		}
		lines = append(lines, fmt.Sprintf("- `%s`: %s differ. Ask the ship's owner for guidance before using %s.", clash.Skill, where, before))
	}
	return append(lines, "")
}
