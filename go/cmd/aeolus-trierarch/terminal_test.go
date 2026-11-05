package main

import (
	"os"
	"testing"
)

func TestIsTerminalIsFalseForTheNullDevice(t *testing.T) {
	null, err := os.OpenFile(os.DevNull, os.O_WRONLY, 0)
	if err != nil {
		t.Skipf("no null device: %v", err)
	}
	defer null.Close()

	if isTerminal(null) {
		t.Fatal("the null device is a character device but no terminal, so stdout on it must not colour")
	}
}
