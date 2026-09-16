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
)

func archiveMAC(filename, passphrase string) ([]byte, error) {
	file, err := os.Open(filename)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	mac := hmac.New(sha256.New, []byte(passphrase))
	if _, err := io.Copy(mac, file); err != nil {
		return nil, err
	}
	return mac.Sum(nil), nil
}

func writeArchiveMAC(filename, passphrase string) error {
	value, err := archiveMAC(filename, passphrase)
	if err != nil {
		return err
	}
	return os.WriteFile(filename+".hmac", []byte(hex.EncodeToString(value)+"\n"), 0600)
}

func verifyArchiveMAC(filename, passphrase string) error {
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
	actual, err := archiveMAC(filename, passphrase)
	if err != nil {
		return err
	}
	if !hmac.Equal(expected, actual) {
		return fmt.Errorf("backup passphrase is incorrect or archive authentication failed")
	}
	return nil
}
