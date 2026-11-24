package fleet

import (
	"slices"
	"testing"
)

func TestTheMinimumCoreVersionTakesACrewRequestsMcpServers(t *testing.T) {
	if slices.Compare(versionOf(MinimumCoreVersion), []int{0, 38, 0}) < 0 {
		t.Fatalf("the Go trierarch needs core %s, and core takes mcpServers from 0.38.0", MinimumCoreVersion)
	}
}

func TestTheMinimumCoreVersionSupportsSendingWithoutAModel(t *testing.T) {
	if slices.Compare(versionOf(MinimumCoreVersion), []int{0, 41, 0}) < 0 {
		t.Fatalf("sending without a model needs core 0.41.0, got %s", MinimumCoreVersion)
	}
}

func TestTheMinimumCoreVersionSupportsMeetingCalls(t *testing.T) {
	if slices.Compare(versionOf(MinimumCoreVersion), []int{0, 46, 0}) < 0 {
		t.Fatalf("meeting calls need core 0.46.0, got %s", MinimumCoreVersion)
	}
}
