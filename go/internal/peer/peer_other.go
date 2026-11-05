//go:build !linux && !darwin

package peer

// peerPID resolves no caller where the trierarch has no way to ask, so every call is refused.
func peerPID(int) int { return 0 }

func parentOf(int) int { return 0 }

func sessionOf(int) int { return 0 }
