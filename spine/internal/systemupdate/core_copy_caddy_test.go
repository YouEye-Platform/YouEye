package systemupdate

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestIndependentCopyCaddyKeepsRoutesAndRemovesInheritedTLSAuthority(t *testing.T) {
	raw := []byte(`{"admin":{"listen":"0.0.0.0:2019"},"apps":{"http":{"servers":{"https":{"routes":[{"handle":[{"handler":"file_server","root":"/ordinary-files"}]}]}}},"tls":{"certificates":{"load_pem":[{"certificate":"fixture-certificate","key":"source-private-authority"}]},"automation":{"policies":[{"subjects":["source.example.test"],"issuers":[{"module":"acme","account_key":"source-account"}]}]}}}}`)
	next, err := copiedCaddyConfiguration(raw)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(next), "source-private-authority") || strings.Contains(string(next), "source-account") || !strings.Contains(string(next), "/ordinary-files") || !strings.Contains(string(next), `"module":"internal"`) {
		t.Fatal("copied TLS authority was retained or ordinary routes changed")
	}
	var changed map[string]any
	if err = json.Unmarshal(raw, &changed); err != nil {
		t.Fatal(err)
	}
	changed["storage"] = map[string]any{"module": "remote"}
	bad, _ := json.Marshal(changed)
	if _, err = copiedCaddyConfiguration(bad); err == nil {
		t.Fatal("accepted external certificate backing")
	}
}
