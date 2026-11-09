package secrets

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"syscall"
)

// ReadPrivate reads a file only its user may read, refusing a link in its place, and narrows a wider mode back to 600.
func ReadPrivate(path string) ([]byte, error) {
	if err := refuseLink(path); err != nil {
		return nil, err
	}
	file, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	if err := file.Chmod(0o600); err != nil {
		return nil, err
	}
	return io.ReadAll(file)
}

// WritePrivate replaces the file whole with the text, never through a link. The text goes into a file of mode 600 from its creation, under a name no one else can know beforehand, made by this call alone, then synced and renamed into place, so a stop mid-write leaves what was held.
func WritePrivate(path string, text []byte) error {
	if err := refuseLink(path); err != nil {
		return err
	}
	folder := filepath.Dir(path)
	if err := os.MkdirAll(folder, 0o755); err != nil {
		return err
	}
	random := make([]byte, 16)
	if _, err := rand.Read(random); err != nil {
		return err
	}
	partial := filepath.Join(folder, "."+filepath.Base(path)+"."+hex.EncodeToString(random)+".partial")
	file, err := os.OpenFile(partial, os.O_WRONLY|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW, 0o600)
	if err != nil {
		return err
	}
	if err := fill(file, text); err != nil {
		_ = os.Remove(partial)
		return err
	}
	if err := os.Rename(partial, path); err != nil {
		_ = os.Remove(partial)
		return err
	}
	return nil
}

// fill writes the text into the fresh file, its mode 600 whatever the umask left, and syncs and closes it.
func fill(file *os.File, text []byte) error {
	err := file.Chmod(0o600)
	if err == nil {
		_, err = file.Write(text)
	}
	if err == nil {
		err = file.Sync()
	}
	return errors.Join(err, file.Close())
}

// refuseLink refuses a link in the file's place: what only its user may read is never written or read through one.
func refuseLink(path string) error {
	info, err := os.Lstat(path)
	if err == nil && info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("%s is a link, and is neither read nor written through", path)
	}
	return nil
}
