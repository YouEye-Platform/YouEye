package backup

import (
	"bufio"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"strings"

	"golang.org/x/crypto/pbkdf2"
)

// opensslSaltHeader starts every archive `openssl enc -salt` writes; its 8-byte salt follows.
const opensslSaltHeader = "Salted__"

// macKey is the .hmac file's key for the archive (see ArchiveEncryption.MAC).
func (e ArchiveEncryption) macKey(file io.Reader, passphrase string) ([]byte, error) {
	if e.MAC == "" {
		return []byte(passphrase), nil
	}
	header := make([]byte, len(opensslSaltHeader)+8)
	if _, err := io.ReadFull(file, header); err != nil || string(header[:len(opensslSaltHeader)]) != opensslSaltHeader {
		return nil, fmt.Errorf("the archive has no OpenSSL salt to authenticate it with")
	}
	salt := append([]byte(archiveMACLabel), header[len(opensslSaltHeader):]...)
	return pbkdf2.Key([]byte(passphrase), salt, e.Iterations, sha256.Size, sha256.New), nil
}

func archiveMAC(filename, passphrase string, encryption ArchiveEncryption) ([]byte, error) {
	file, err := os.Open(filename)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	key, err := encryption.macKey(file, passphrase)
	if err != nil {
		return nil, err
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return nil, err
	}
	mac := hmac.New(sha256.New, key)
	if _, err := io.Copy(mac, file); err != nil {
		return nil, err
	}
	return mac.Sum(nil), nil
}

func writeArchiveMAC(filename, passphrase string, encryption ArchiveEncryption) error {
	value, err := archiveMAC(filename, passphrase, encryption)
	if err != nil {
		return err
	}
	return os.WriteFile(filename+".hmac", []byte(hex.EncodeToString(value)+"\n"), 0600)
}

func verifyArchiveMAC(filename, passphrase string, encryption ArchiveEncryption) error {
	file, err := os.Open(filename + ".hmac")
	if err != nil {
		return fmt.Errorf("authenticated archive checksum is missing")
	}
	defer file.Close()
	line, err := bufio.NewReader(io.LimitReader(file, 256)).ReadString('\n')
	if err != nil && err != io.EOF {
		return err
	}
	expected, err := hex.DecodeString(strings.TrimSpace(line))
	if err != nil || len(expected) != sha256.Size {
		return fmt.Errorf("authenticated archive checksum is invalid")
	}
	actual, err := archiveMAC(filename, passphrase, encryption)
	if err != nil {
		return err
	}
	if !hmac.Equal(expected, actual) {
		return fmt.Errorf("backup passphrase is incorrect or archive authentication failed")
	}
	return nil
}
