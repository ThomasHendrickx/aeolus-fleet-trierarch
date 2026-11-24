package guard

import (
	"context"
	"errors"
	"path"
	"strings"
)

// maxLinks bounds the symbolic links one path resolves through.
const maxLinks = 40

var errLinkLoop = errors.New("symbolic link loop")

// resolve makes an absolute, cleaned path real: every symbolic link in it,
// those the call itself makes first, followed.
func (c Checker) resolve(ctx context.Context, absolute string, made map[string]string) (string, error) {
	segments := splitPath(absolute)
	resolved := "/"
	hops := 0
	for index := 0; index < len(segments); index++ {
		if err := ctx.Err(); err != nil {
			return "", err
		}
		next := path.Join(resolved, segments[index])
		target, isLink := made[next]
		if !isLink {
			var err error
			target, isLink, err = c.Links.Readlink(ctx, next)
			if err != nil {
				return "", err
			}
		}
		if !isLink {
			resolved = next
			continue
		}
		hops++
		if hops > maxLinks {
			return "", errLinkLoop
		}
		if !path.IsAbs(target) {
			target = path.Join(resolved, target)
		}
		segments = append(splitPath(path.Clean(target)), segments[index+1:]...)
		resolved = "/"
		index = -1
	}
	return resolved, nil
}

func splitPath(absolute string) []string {
	var segments []string
	for _, segment := range strings.Split(absolute, "/") {
		if segment != "" {
			segments = append(segments, segment)
		}
	}
	return segments
}

// within is whether p is root or lies under it.
func within(p, root string) bool {
	root = path.Clean(root)
	return p == root || strings.HasPrefix(p, strings.TrimSuffix(root, "/")+"/")
}

// globMatch matches a path against a glob whose ** stands for any number of
// folders and whose other segments match as path.Match does.
func globMatch(pattern, p string) bool {
	return matchSegments(splitPath(pattern), splitPath(p))
}

func matchSegments(pattern, segments []string) bool {
	if len(pattern) == 0 {
		return len(segments) == 0
	}
	if pattern[0] == "**" {
		if matchSegments(pattern[1:], segments) {
			return true
		}
		return len(segments) > 0 && matchSegments(pattern, segments[1:])
	}
	if len(segments) == 0 {
		return false
	}
	matched, err := path.Match(pattern[0], segments[0])
	return err == nil && matched && matchSegments(pattern[1:], segments[1:])
}

// reachesMatch is whether a write that reaches everything under p reaches a
// path the glob matches: p itself, or p an ancestor of what the glob names
// by name. A ** that only stands for p's last folders names nothing in it.
func reachesMatch(pattern, p string) bool {
	return reaches(splitPath(pattern), splitPath(p), false)
}

func reaches(pattern, segments []string, byStar bool) bool {
	if len(segments) == 0 {
		return len(pattern) == 0 || !byStar
	}
	if len(pattern) == 0 {
		return false
	}
	if pattern[0] == "**" {
		return reaches(pattern[1:], segments, byStar) || reaches(pattern, segments[1:], true)
	}
	matched, err := path.Match(pattern[0], segments[0])
	return err == nil && matched && reaches(pattern[1:], segments[1:], false)
}

// hits is whether a write target is matched by the glob.
func hits(pattern string, target writeTarget, p string) bool {
	if target.recursive {
		return reachesMatch(pattern, p)
	}
	return globMatch(pattern, p)
}
